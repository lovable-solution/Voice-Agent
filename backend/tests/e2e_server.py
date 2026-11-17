"""Run the real app with scripted stand-ins for Claude (and optionally Deepgram), for browser tests.

    python -m tests.e2e_server --port 8765                     # the browser transcribes speech
    python -m tests.e2e_server --port 8766 --speech scripted   # "Deepgram" transcribes speech

Serves the built frontend (frontend/dist) and the API on one origin. Replies stream word
by word like the real model, so the browser exercises the same code paths. With
`--speech scripted`, the real microphone pipeline runs (audio worklet, 16 kHz PCM over the
speech socket, the relay) and a scripted service "hears" a fixed sequence of turns.
"""

from __future__ import annotations

import argparse
import asyncio
from collections.abc import AsyncGenerator, AsyncIterator, Sequence
from typing import Any

import uvicorn

from app.config import Settings
from app.main import create_app
from app.schemas import Briefing, ClientPersona
from app.speech import TurnSettings

OPENING = "Hi Alex, thanks for making the time. Shall we start with the tracking portal?"
LONG_REPLY = (
    "Sure, let me walk you through the whole scope. First, the booking flow has to be rebuilt from scratch. "
    "Second, the live map needs the vessel tracking feed. Third, customers need their customs documents in one place. "
    "Fourth, admins must manage their own staff. And finally, we need a proper hand-over."
)
SHARED_REPLY = (
    "Thanks for sending that over. I've had a quick look. A pilot with three agents sounds sensible, "
    "but who covers support during the pilot?"
)
DEFAULT_REPLY = "That's helpful, thank you. What similar project have you delivered, and how long did it take?"


class ScriptedLLM:
    credentials_configured = True

    async def generate_briefing(self, *, system: str, prompt: str) -> Briefing:
        await asyncio.sleep(0.3)
        return Briefing(
            persona=ClientPersona(
                name="Morgan Reyes",
                role="Head of Digital",
                company="Northwind Freight",
                company_summary="A 120-person freight forwarder in Rotterdam modernizing its customer tools.",
                communication_style="Calm and precise; asks for concrete examples.",
            ),
            meeting_title="Discovery call: customer tracking portal",
            situation="Northwind needs its tracking portal replaced before the spring peak season.",
            project_summary="Rebuild the customer portal: booking, live map, documents.",
            partnership_summary="A white-label version for partner agents with a 60/40 revenue share.",
            key_facts=["Budget is €45,000–€55,000 fixed price", "Four months, starting in January"],
            priorities=["Launch before peak season"],
            concerns=["A 40% revenue share is high"],
            questions_to_ask=["What similar platform have you built?"],
            agenda=["Introductions", "Scope and timeline", "Partnership idea"],
            opening_line=OPENING,
            speech_keyterms=["Northwind", "AIS", "SQL Server"],
        )

    async def stream_reply(self, *, system: str, messages: Sequence[dict[str, str]]) -> AsyncGenerator[str, None]:
        last = messages[-1]["content"]
        if "<shared_document" in last:
            reply = SHARED_REPLY
        elif "explain" in last.lower():
            reply = LONG_REPLY
        else:
            reply = DEFAULT_REPLY
        words = reply.split(" ")
        for index, word in enumerate(words):
            await asyncio.sleep(0.01)
            yield word if index == len(words) - 1 else word + " "


# --------------------------------------------------------------------------- scripted speech recognition


def _turn_info(event: str, transcript: str, turn_index: int) -> dict[str, Any]:
    return {
        "type": "TurnInfo",
        "event": event,
        "turn_index": turn_index,
        "transcript": transcript,
        "words": [],
        "end_of_turn_confidence": 0.9 if event == "EndOfTurn" else 0.2,
    }


class ScriptedSpeech:
    """Stands in for Deepgram Flux: once the app has listened for 0.8 s, it "hears" the next turn."""

    TURNS = ("Hello, I'm Ross, and I move data into SQL Server warehouses.", "We could start in March.")

    def __init__(self) -> None:
        self.remaining = list(self.TURNS)
        self.keyterms: list[str] = []
        self.frame_sizes: set[int] = set()
        self.frames_while_listening = 0
        self.nonzero_frames_while_paused = 0

    async def open(self, *, keyterms: Sequence[str], turn: TurnSettings) -> ScriptedSpeechStream:
        self.keyterms = list(keyterms)
        return ScriptedSpeechStream(self)

    def report(self) -> dict[str, Any]:
        return {
            "keyterms": self.keyterms,
            "frame_sizes": sorted(self.frame_sizes),
            "frames_while_listening": self.frames_while_listening,
            "nonzero_frames_while_paused": self.nonzero_frames_while_paused,
        }


class ScriptedSpeechStream:
    def __init__(self, owner: ScriptedSpeech) -> None:
        self.owner = owner
        self.listening = False
        self.heard_ms = 0.0
        self.turn_index = 0
        self.chunks = 0
        self.speaking: asyncio.Task[None] | None = None
        self._queue: asyncio.Queue[dict[str, Any] | None] | None = None

    @property
    def queue(self) -> asyncio.Queue[dict[str, Any] | None]:
        if self._queue is None:
            self._queue = asyncio.Queue()
        return self._queue

    async def send_audio(self, chunk: bytes) -> None:
        owner = self.owner
        owner.frame_sizes.add(len(chunk))
        self.chunks += 1
        if self.chunks % 3 == 0 and self.speaking is None:
            # Like Flux: an Update for every ~0.25 s of audio, silence included, for the coming turn.
            self.queue.put_nowait(_turn_info("Update", "", self.turn_index))
        if not self.listening:
            owner.nonzero_frames_while_paused += any(chunk)  # must stay 0: silence while not listening
            return
        owner.frames_while_listening += 1
        self.heard_ms += len(chunk) / 32  # 16 kHz, 2 bytes per sample
        if self.heard_ms >= 800 and owner.remaining and self.speaking is None:
            self.speaking = asyncio.create_task(self._speak(owner.remaining.pop(0)))

    async def _speak(self, text: str) -> None:
        words = text.split()
        for count in range(1, len(words) + 1):
            self.queue.put_nowait(_turn_info("StartOfTurn" if count == 1 else "Update", " ".join(words[:count]), self.turn_index))
            await asyncio.sleep(0.05)
        self.queue.put_nowait(_turn_info("EndOfTurn", text, self.turn_index))
        self.turn_index += 1
        self.heard_ms = 0
        self.speaking = None

    async def end_turn(self) -> None:
        pass

    async def configure(self, turn: TurnSettings) -> None:
        pass

    def set_listening(self, on: bool) -> None:
        self.listening = on
        self.heard_ms = 0

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        yield {"type": "Connected", "request_id": "scripted", "sequence_id": 0}
        while (message := await self.queue.get()) is not None:
            yield message

    async def close(self) -> None:
        if self.speaking is not None:
            self.speaking.cancel()
        self.queue.put_nowait(None)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--speech", choices=["browser", "scripted"], default="browser")
    args = parser.parse_args()
    settings = Settings(
        _env_file=None,  # independent of the developer's backend/.env
        deepgram_api_key=None,
        cors_origins=[f"http://127.0.0.1:{args.port}", f"http://localhost:{args.port}"],
    )
    speech = ScriptedSpeech() if args.speech == "scripted" else None
    app = create_app(settings=settings, llm=ScriptedLLM(), speech_to_text=speech)
    if speech is not None:
        # What the scripted service received, for the browser test to check. Moved to the front so
        # the frontend mounted at "/" doesn't shadow it.
        app.add_api_route("/api/e2e/speech", speech.report, methods=["GET"])
        app.router.routes.insert(0, app.router.routes.pop())
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
