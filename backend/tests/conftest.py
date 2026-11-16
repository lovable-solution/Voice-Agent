from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Iterator, Sequence
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.schemas import Briefing, ClientPersona

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


@pytest.fixture
def fake_llm() -> FakeLLM:
    return FakeLLM()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        anthropic_api_key="test-key",
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
