"""Speech-to-text with Deepgram Flux, relayed through the server.

Used only when DEEPGRAM_API_KEY is set; otherwise the browser's own speech recognition
transcribes the participant (frontend/src/speech/recognizer.ts).

The browser streams the microphone to /api/sessions/{id}/speech as 16 kHz, 16-bit, mono PCM,
about 80 ms per binary frame (Deepgram's recommended chunk size). While the app isn't listening,
for example while the client talks over the speakers, it sends silence instead, so the stream
stays continuous and the client's own voice is never transcribed. Flux transcribes the audio and
also decides when the participant has finished their turn. That works better than a fixed silence
timeout: it waits through a pause in the middle of a sentence but ends a finished thought quickly.
The Deepgram key never leaves the server.

Protocol: /api/sessions/{id}/speech?eot_threshold=0.75&eot_timeout_ms=4750

browser -> server
    <binary frame>                               microphone audio
    {"type": "listening", "on": true | false}    the app started or stopped listening
    {"type": "end_turn"}                         end any turn in progress now
    {"type": "configure", "eot_threshold": 0.8, "eot_timeout_ms": 6000}

server -> browser
    {"type": "ready"}                            Deepgram accepted the stream
    {"type": "turn", "event": "...", "turn_index": 0, "transcript": "..."}
        Flux's TurnInfo: event is StartOfTurn, Update, EagerEndOfTurn, TurnResumed, or EndOfTurn,
        and transcript is everything said so far in that turn.
    {"type": "error", "code": "...", "message": "...", "retryable": bool}   then the socket closes
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import re
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol
from urllib.parse import urlencode

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

from .config import Settings
from .realtime import origin_allowed
from .schemas import Briefing

if TYPE_CHECKING:
    from .store import Session

logger = logging.getLogger(__name__)

router = APIRouter()

SAMPLE_RATE = 16_000
MAX_KEYTERMS = 50  # Flux accepts up to 100 keyterms (500 tokens) per stream
MAX_KEYTERM_CHARS = 60
MAX_AUDIO_FRAME_BYTES = 64 * 1024

# Application close codes for the speech socket (4000-4999 are free for application use).
CLOSE_FATAL = 4400  # not configured, or the key was rejected: reconnecting won't help
CLOSE_FORBIDDEN_ORIGIN = 4403
CLOSE_NOT_FOUND = 4404
CLOSE_REPLACED = 4409
CLOSE_ENDED = 4410
CLOSE_RETRY = 4503  # Deepgram was unreachable or the stream failed: reconnecting may help


class SpeechError(Exception):
    """A failure to transcribe, with a message that is safe to show the user."""

    def __init__(self, message: str, *, code: str, retryable: bool) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class TurnSettings:
    """How Flux decides the participant has finished a turn (Deepgram's eot_* parameters)."""

    eot_threshold: float = 0.7  # confidence needed to end a turn, 0.5-1.0; higher waits longer
    eot_timeout_ms: int = 5_000  # silence that ends a turn regardless of confidence, 500-60,000

    @classmethod
    def parse(cls, threshold: object, timeout_ms: object) -> TurnSettings:
        """Clamp to Flux's valid ranges; anything unparsable keeps the default."""
        default = cls()
        return cls(
            eot_threshold=round(_clamp(_number(threshold, default.eot_threshold), 0.5, 1.0), 2),
            eot_timeout_ms=int(_clamp(_number(timeout_ms, default.eot_timeout_ms), 500, 60_000)),
        )


def _number(value: object, default: float) -> float:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _first_name(name: str | None) -> str | None:
    return name.split()[0] if name and name.split() else None


def speech_keyterms(briefing: Briefing, user_name: str | None) -> list[str]:
    """Terms the recognizer should favour: the people in the meeting, then the briefing's list."""
    persona = briefing.persona
    candidates = [
        user_name,
        _first_name(user_name),
        persona.name,
        _first_name(persona.name),
        persona.company,
        *briefing.speech_keyterms,
    ]
    terms: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        # Deepgram takes plain words and phrases: commas and semicolons would become part of the term.
        term = " ".join(re.sub(r"[,;]", " ", candidate or "").split())
        if not term or len(term) > MAX_KEYTERM_CHARS or term.lower() in seen:
            continue
        seen.add(term.lower())
        terms.append(term)
        if len(terms) == MAX_KEYTERMS:
            break
    return terms


# --------------------------------------------------------------------------- the speech service


class SpeechStream(Protocol):
    """One streaming transcription session."""

    async def send_audio(self, chunk: bytes) -> None: ...

    async def end_turn(self) -> None: ...

    async def configure(self, turn: TurnSettings) -> None: ...

    def set_listening(self, on: bool) -> None: ...

    def events(self) -> AsyncIterator[dict[str, Any]]: ...

    async def close(self) -> None: ...


class SpeechToText(Protocol):
    async def open(self, *, keyterms: Sequence[str], turn: TurnSettings) -> SpeechStream: ...


class DeepgramFlux:
    """Deepgram's Flux model over its streaming API."""

    def __init__(self, settings: Settings) -> None:
        self._key = settings.deepgram_api_key or ""
        self._model = settings.deepgram_model
        self._url = settings.deepgram_url

    def stream_url(self, keyterms: Sequence[str], turn: TurnSettings) -> str:
        params = [
            ("model", self._model),
            ("encoding", "linear16"),
            ("sample_rate", str(SAMPLE_RATE)),
            ("eot_threshold", f"{turn.eot_threshold:g}"),
            ("eot_timeout_ms", str(turn.eot_timeout_ms)),
            *(("keyterm", term) for term in keyterms),
        ]
        return f"{self._url}?{urlencode(params)}"

    async def open(self, *, keyterms: Sequence[str], turn: TurnSettings) -> SpeechStream:
        try:
            ws = await connect(
                self.stream_url(keyterms, turn),
                additional_headers={"Authorization": f"Token {self._key}"},
                open_timeout=10,
            )
        except InvalidStatus as exc:
            raise status_error(exc.response.status_code, exc.response.body) from exc
        except (OSError, TimeoutError, InvalidHandshake) as exc:
            raise SpeechError(
                "Couldn't reach Deepgram for speech recognition. Check your internet connection or VPN.",
                code="unavailable",
                retryable=True,
            ) from exc
        return _FluxStream(ws)


def status_error(status: int, body: bytes | None) -> SpeechError:
    """Map a refused WebSocket upgrade to a user-facing error."""
    if status in (401, 403):
        return SpeechError(
            "Deepgram rejected the API key. Check DEEPGRAM_API_KEY in backend/.env.", code="auth", retryable=False
        )
    if status == 402:
        return SpeechError("The Deepgram account is out of credit.", code="auth", retryable=False)
    if status == 429:
        return SpeechError("Deepgram is rate limiting requests. Trying again shortly.", code="unavailable", retryable=True)
    if status >= 500:
        return SpeechError(
            f"Deepgram is having trouble (HTTP {status}). Trying again shortly.", code="unavailable", retryable=True
        )
    detail = _error_detail(body)
    return SpeechError(
        f"Deepgram refused the audio stream (HTTP {status}){': ' + detail if detail else ''}.",
        code="bad_request",
        retryable=False,
    )


def _error_detail(body: bytes | None) -> str:
    if not body:
        return ""
    text = body.decode("utf-8", "replace").strip()
    try:
        data = json.loads(text)
    except ValueError:
        return text[:200].rstrip(".")
    if isinstance(data, dict):
        for key in ("err_msg", "message", "description", "error"):
            if isinstance(data.get(key), str):
                return data[key][:200].rstrip(".")
    return text[:200].rstrip(".")


class _FluxStream:
    def __init__(self, ws: ClientConnection) -> None:
        self._ws = ws

    async def send_audio(self, chunk: bytes) -> None:
        await self._ws.send(chunk)

    async def end_turn(self) -> None:
        await self._ws.send(json.dumps({"type": "ForceEndTurn"}))

    async def configure(self, turn: TurnSettings) -> None:
        thresholds = {"eot_threshold": turn.eot_threshold, "eot_timeout_ms": turn.eot_timeout_ms}
        await self._ws.send(json.dumps({"type": "Configure", "thresholds": thresholds}))

    def set_listening(self, on: bool) -> None:
        """Nothing to tell Flux: it receives silence while the app isn't listening."""

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        try:
            async for message in self._ws:
                if isinstance(message, bytes):
                    continue
                try:
                    data = json.loads(message)
                except ValueError:
                    continue
                if isinstance(data, dict):
                    yield data
        except ConnectionClosed:
            return

    async def close(self) -> None:
        with contextlib.suppress(ConnectionClosed, OSError):
            await self._ws.send(json.dumps({"type": "CloseStream"}))
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self._ws.close(), timeout=2)


# --------------------------------------------------------------------------- the relay


class _BrowserGone(Exception):
    """The browser's socket closed."""


@router.websocket("/api/sessions/{session_id}/speech")
async def speech_socket(websocket: WebSocket, session_id: str) -> None:
    if not origin_allowed(websocket):
        await websocket.close(code=CLOSE_FORBIDDEN_ORIGIN)
        return
    session: Session | None = websocket.app.state.store.get(session_id)
    await websocket.accept()
    if session is None:
        await _fail(websocket, SpeechError("Meeting session not found.", code="not_found", retryable=False), CLOSE_NOT_FOUND)
        return
    speech: SpeechToText | None = websocket.app.state.speech
    if speech is None or session.speech_engine != "deepgram":
        error = SpeechError(
            "Speech recognition by Deepgram isn't set up on the server. Add DEEPGRAM_API_KEY to backend/.env.",
            code="not_configured",
            retryable=False,
        )
        await _fail(websocket, error)
        return
    params = websocket.query_params
    turn = TurnSettings.parse(params.get("eot_threshold"), params.get("eot_timeout_ms"))
    await SpeechRelay(websocket, session, speech, turn).run()


async def _fail(websocket: WebSocket, error: SpeechError, code: int | None = None) -> None:
    payload = {"type": "error", "code": error.code, "message": error.message, "retryable": error.retryable}
    with contextlib.suppress(WebSocketDisconnect, RuntimeError, OSError):
        await websocket.send_text(json.dumps(payload))
        await websocket.close(code=code if code is not None else (CLOSE_RETRY if error.retryable else CLOSE_FATAL))


class SpeechRelay:
    """Relays one browser's microphone to the speech service, and the transcripts back."""

    def __init__(self, websocket: WebSocket, session: Session, speech: SpeechToText, turn: TurnSettings) -> None:
        self.ws = websocket
        self.session = session
        self.speech = speech
        self.turn = turn
        self._closed = False

    async def run(self) -> None:
        session = self.session
        previous, session.speech_relay = session.speech_relay, self
        if previous is not None:
            await previous.shutdown(code=CLOSE_REPLACED, reason="The meeting was opened in another window.")
        try:
            try:
                stream = await self.speech.open(keyterms=session.speech_keyterms, turn=self.turn)
            except SpeechError as error:
                logger.warning("Speech stream didn't open: %s", error.message)
                await _fail(self.ws, error)
                return
            error = await self._relay(stream)
            if error is not None:
                logger.warning("Speech stream ended: %s", error.message)
                await _fail(self.ws, error)
        finally:
            self._detach()

    async def shutdown(self, *, code: int, reason: str = "") -> None:
        """Stop this relay from outside (replaced by a new one, or the meeting ended)."""
        if self._closed:
            return
        self._closed = True
        # The browser may have gone already; closing its socket then must not fail the caller.
        with contextlib.suppress(WebSocketDisconnect, RuntimeError, OSError):
            await self.ws.close(code=code, reason=reason)

    def _detach(self) -> None:
        if self.session.speech_relay is self:
            self.session.speech_relay = None

    async def _relay(self, stream: SpeechStream) -> SpeechError | None:
        """Pump both ways until one side stops. Returns why the speech service stopped, or None."""
        up = asyncio.create_task(self._upstream(stream))
        down = asyncio.create_task(self._downstream(stream))
        try:
            done, _ = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in (up, down):
                task.cancel()
            await asyncio.gather(up, down, return_exceptions=True)
            self._detach()  # before the (slow) close: nothing should reach this relay any more
            await stream.close()
        if self._closed:
            return None  # shut down from outside
        task = down if down in done else up
        exc = task.exception()
        if exc is None:
            return task.result()
        if isinstance(exc, SpeechError):
            return exc
        if isinstance(exc, _BrowserGone):
            return None
        logger.error("Speech relay failed", exc_info=exc)
        return SpeechError("Speech recognition stopped unexpectedly.", code="internal", retryable=True)

    async def _upstream(self, stream: SpeechStream) -> None:
        """Browser to speech service, until the browser disconnects."""
        while True:
            try:
                message = await self.ws.receive()
            except (WebSocketDisconnect, RuntimeError):
                return
            if message["type"] == "websocket.disconnect":
                return
            try:
                if (data := message.get("bytes")) is not None:
                    if len(data) <= MAX_AUDIO_FRAME_BYTES:
                        await stream.send_audio(data)
                elif (text := message.get("text")) is not None:
                    await self._control(stream, text)
            except (ConnectionClosed, OSError) as exc:
                raise SpeechError("The connection to Deepgram was lost.", code="unavailable", retryable=True) from exc

    async def _control(self, stream: SpeechStream, text: str) -> None:
        try:
            data = json.loads(text)
        except ValueError:
            return
        if not isinstance(data, dict):
            return
        kind = data.get("type")
        if kind == "end_turn":
            await stream.end_turn()
        elif kind == "configure":
            self.turn = TurnSettings.parse(data.get("eot_threshold"), data.get("eot_timeout_ms"))
            await stream.configure(self.turn)
        elif kind == "listening":
            stream.set_listening(bool(data.get("on")))

    async def _downstream(self, stream: SpeechStream) -> SpeechError | None:
        """Speech service to browser. Returns why the service stopped, or None if the browser left."""
        last: tuple[int, str] | None = None
        try:
            async for message in stream.events():
                kind = message.get("type")
                if kind == "Connected":
                    await self._send({"type": "ready"})
                elif kind == "TurnInfo":
                    event = str(message.get("event") or "")
                    index = int(_number(message.get("turn_index"), 0))
                    transcript = str(message.get("transcript") or "").strip()
                    if event == "Update" and (not transcript or last == (index, transcript)):
                        continue  # Flux sends an Update for every ~0.25 s of audio, silence included
                    last = (index, transcript)
                    await self._send({"type": "turn", "event": event, "turn_index": index, "transcript": transcript})
                elif kind == "Error":
                    detail = message.get("description") or message.get("code") or "unknown error"
                    return SpeechError(f"Deepgram stopped transcribing: {detail}", code="deepgram", retryable=True)
                elif kind in ("Warning", "ConfigureFailure"):
                    logger.info("Deepgram %s: %s %s", kind, message.get("code"), message.get("description"))
        except _BrowserGone:
            return None
        return SpeechError("The connection to Deepgram closed.", code="unavailable", retryable=True)

    async def _send(self, payload: dict[str, Any]) -> None:
        try:
            await self.ws.send_text(json.dumps(payload))
        except (WebSocketDisconnect, RuntimeError, OSError) as exc:
            raise _BrowserGone from exc
