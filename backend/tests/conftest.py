from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator, Iterator, Sequence
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.schemas import Briefing, ClientPersona
from app.speech import SpeechError, TurnSettings

JOB_POSTING = """Senior React Developer (contract, 3 months)
We're FinFlow, a 40-person fintech startup. We need a senior React developer to rebuild our customer dashboard.
Budget: $18,000 fixed price. Must know TypeScript and charting libraries. Start date: March 3."""


def make_briefing(**overrides: object) -> Briefing:
    data: dict[str, object] = {
        "persona": ClientPersona(
            name="Jordan Lee",
            role="Head of Product",
            company="FinFlow",
            company_summary="A 40-person fintech startup building cash-flow tools for small businesses.",
            communication_style="Friendly but to the point; likes concrete examples.",
        ),
        "meeting_title": "Discovery call: customer dashboard rebuild",
        "situation": "FinFlow needs its dashboard rebuilt before a funding round.",
        "project_summary": "Rebuild the customer dashboard in React and TypeScript.",
        "partnership_summary": "",
        "key_facts": ["Budget is $18,000 fixed price", "Start date is March 3"],
        "priorities": ["Ship before the funding round"],
        "concerns": ["Past contractors missed deadlines"],
        "questions_to_ask": ["What similar dashboards have you built?"],
        "agenda": ["Introductions", "Scope", "Timeline and budget"],
        "opening_line": "Hi Alex, thanks for joining. Shall we dive into the dashboard project?",
        "speech_keyterms": ["React", "TypeScript", "FinFlow", "charting libraries"],
    }
    data.update(overrides)
    return Briefing.model_validate(data)


class FakeLLM:
    """Scripted stand-in for Claude. Replies stream word by word.

    Each scripted reply is a string, an exception to raise before any output, or a
    `(text, exception)` pair that streams the text and then fails.
    """

    credentials_configured = True

    def __init__(self) -> None:
        self.briefing = make_briefing()
        self.briefing_error: Exception | None = None
        self.replies: list[str | Exception | tuple[str, Exception]] = []
        self.default_reply = "That makes sense. Can you tell me about a similar project you've delivered?"
        self.delay = 0.0
        self.briefing_calls: list[dict[str, str]] = []
        self.reply_calls: list[dict[str, object]] = []
        self.closed_streams = 0

    async def generate_briefing(self, *, system: str, prompt: str) -> Briefing:
        self.briefing_calls.append({"system": system, "prompt": prompt})
        if self.briefing_error is not None:
            raise self.briefing_error
        return self.briefing.model_copy(deep=True)

    async def stream_reply(self, *, system: str, messages: Sequence[dict[str, str]]) -> AsyncGenerator[str, None]:
        self.reply_calls.append({"system": system, "messages": [dict(m) for m in messages]})
        reply = self.replies.pop(0) if self.replies else self.default_reply
        failure: Exception | None = None
        if isinstance(reply, Exception):
            reply, failure = "", reply
        elif isinstance(reply, tuple):
            reply, failure = reply
        try:
            words = reply.split(" ") if reply else []
            for index, word in enumerate(words):
                if self.delay:
                    await asyncio.sleep(self.delay)
                yield word if index == len(words) - 1 else word + " "
            if failure is not None:
                raise failure
        finally:
            self.closed_streams += 1


class FakeSpeechStream:
    """A scripted speech-to-text stream: each audio chunk it receives releases the next batch of
    scripted service messages (Flux-shaped dicts; `None` ends the stream as if Deepgram hung up)."""

    def __init__(self, owner: FakeSpeech, keyterms: Sequence[str], turn: TurnSettings) -> None:
        self.owner = owner
        self.keyterms = list(keyterms)
        self.turn = turn
        self.audio: list[bytes] = []
        self.controls: list[object] = []
        self.closed = False
        self._queue: asyncio.Queue[dict[str, Any] | None] | None = None

    @property
    def queue(self) -> asyncio.Queue[dict[str, Any] | None]:
        if self._queue is None:  # created lazily, on the app's event loop
            self._queue = asyncio.Queue()
        return self._queue

    async def send_audio(self, chunk: bytes) -> None:
        self.audio.append(chunk)
        if self.owner.script:
            for message in self.owner.script.pop(0):
                self.queue.put_nowait(message)

    async def end_turn(self) -> None:
        self.controls.append("end_turn")

    async def configure(self, turn: TurnSettings) -> None:
        self.controls.append(("configure", turn))

    def set_listening(self, on: bool) -> None:
        self.controls.append(("listening", on))

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        yield {"type": "Connected", "request_id": "req_1", "sequence_id": 0}
        while (message := await self.queue.get()) is not None:
            yield message

    async def close(self) -> None:
        self.closed = True
        self.queue.put_nowait(None)


class FakeSpeech:
    """Stands in for Deepgram."""

    def __init__(self) -> None:
        self.script: list[list[dict[str, Any] | None]] = []
        self.open_error: SpeechError | None = None
        self.streams: list[FakeSpeechStream] = []

    async def open(self, *, keyterms: Sequence[str], turn: TurnSettings) -> FakeSpeechStream:
        if self.open_error is not None:
            raise self.open_error
        stream = FakeSpeechStream(self, keyterms, turn)
        self.streams.append(stream)
        return stream


def turn_info(event: str, transcript: str, turn_index: int = 0) -> dict[str, Any]:
    """A Flux TurnInfo message."""
    return {
        "type": "TurnInfo",
        "request_id": "req_1",
        "sequence_id": 1,
        "event": event,
        "turn_index": turn_index,
        "audio_window_start": 0.0,
        "audio_window_end": 1.0,
        "transcript": transcript,
        "words": [],
        "end_of_turn_confidence": 0.5,
    }


@pytest.fixture
def fake_llm() -> FakeLLM:
    return FakeLLM()


@pytest.fixture
def fake_speech() -> FakeSpeech:
    return FakeSpeech()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        _env_file=None,  # independent of the developer's backend/.env
        anthropic_api_key="test-key",
        deepgram_api_key=None,
        frontend_dist=tmp_path / "no-frontend",
        cors_origins=["http://localhost:5173"],
        max_upload_mb=1,
    )


@pytest.fixture
def client(settings: Settings, fake_llm: FakeLLM) -> Iterator[TestClient]:
    app = create_app(settings=settings, llm=fake_llm)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def speech_client(settings: Settings, fake_llm: FakeLLM, fake_speech: FakeSpeech) -> Iterator[TestClient]:
    """The app with speech recognition by (fake) Deepgram."""
    app = create_app(settings=settings, llm=fake_llm, speech_to_text=fake_speech)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def session_id(client: TestClient) -> str:
    response = client.post(
        "/api/sessions",
        json={
            "materials": [{"kind": "job_posting", "content": JOB_POSTING}],
            "user_name": "Alex Kim",
            "personality": "skeptical",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]
