"""Request/response models for the REST API and the meeting WebSocket protocol."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field, TypeAdapter, field_validator

MAX_MATERIAL_CHARS = 60_000
MAX_UTTERANCE_CHARS = 4_000

MaterialKind = Literal["job_posting", "partnership", "notes"]
Personality = Literal["friendly", "neutral", "skeptical", "demanding"]
MessageKind = Literal["speech", "typed", "event", "material", "reply"]
# Who transcribes the participant: Deepgram (relayed by the server) or the browser itself.
SpeechEngine = Literal["deepgram", "browser"]

KIND_LABELS: dict[str, str] = {
    "job_posting": "Job posting",
    "partnership": "Partnership ideas",
    "notes": "Notes",
}


def _blank_to_none(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


# --------------------------------------------------------------------------- materials


class MaterialIn(BaseModel):
    """A piece of knowledge the client should learn: a job posting, partnership ideas, notes."""

    kind: MaterialKind
    title: str | None = Field(default=None, max_length=200)
    content: str = Field(min_length=1, max_length=MAX_MATERIAL_CHARS)

    @field_validator("content")
    @classmethod
    def _content_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("content must not be blank")
        return value

    @field_validator("title")
    @classmethod
    def _clean_title(cls, value: str | None) -> str | None:
        return _blank_to_none(value)


class Material(BaseModel):
    id: str
    kind: MaterialKind
    title: str
    content: str
    shared_during_meeting: bool = False
    added_at: datetime


# --------------------------------------------------------------------------- briefing
# This model doubles as the structured-output schema for the briefing request, so the
# field descriptions are written as instructions to the model.


class ClientPersona(BaseModel):
    name: str = Field(description="The client contact's full name.")
    role: str = Field(description="Their job title.")
    company: str = Field(description="The company's name.")
    company_summary: str = Field(
        description="One or two sentences on what the company does, its size, and its current situation."
    )
    communication_style: str = Field(description="One sentence on how this person talks in meetings.")


class Briefing(BaseModel):
    persona: ClientPersona
    meeting_title: str = Field(description="A short title for the meeting, e.g. 'Discovery call: mobile app rebuild'.")
    situation: str = Field(
        description=(
            "Two to four sentences from the client's point of view: why this meeting is happening "
            "and what they want to get out of it."
        )
    )
    project_summary: str = Field(
        description="Two or three sentences summarizing the project or job. Empty string if no project material was provided."
    )
    partnership_summary: str = Field(
        description=(
            "Two or three sentences summarizing the partnership ideas and the client's first impression of them. "
            "Empty string if no partnership ideas were provided."
        )
    )
    key_facts: list[str] = Field(
        description=(
            "The concrete facts the client knows and may bring up (scope, deliverables, requirements, budget, "
            "timeline, tech, terms), one short statement each."
        )
    )
    priorities: list[str] = Field(description="What the client cares about most, most important first.")
    concerns: list[str] = Field(description="Doubts, risks, and objections the client is likely to raise.")
    questions_to_ask: list[str] = Field(
        description="Four to seven questions the client plans to ask the participant, in the order they'd come up."
    )
    agenda: list[str] = Field(description="Three to five agenda points the client has in mind for the meeting.")
    opening_line: str = Field(
        description=(
            "What the client says first when the participant joins the call: a natural greeting plus a sentence "
            "that sets up the meeting. One or two spoken sentences, plain text."
        )
    )
    speech_keyterms: list[str] = Field(
        description=(
            "Up to 40 words and short phrases the participant is likely to say aloud in this meeting that a speech "
            "recognizer could mishear: names of people, companies, products, and places, plus technical terms and "
            "acronyms from the material (for example 'SQL Server', 'SSIS', 'Shopify'). Spell each exactly as it "
            "is written, one term per item."
        )
    )


# --------------------------------------------------------------------------- sessions


class SessionCreate(BaseModel):
    materials: list[MaterialIn] = Field(min_length=1, max_length=8)
    user_name: str | None = Field(default=None, max_length=80)
    user_background: str | None = Field(default=None, max_length=4_000)
    client_name: str | None = Field(default=None, max_length=80)
    personality: Personality = "neutral"

    @field_validator("user_name", "user_background", "client_name")
    @classmethod
    def _clean(cls, value: str | None) -> str | None:
        return _blank_to_none(value)


class ChatMessageOut(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    kind: MessageKind
    content: str
    interrupted: bool = False
    material_id: str | None = None
    created_at: datetime


class SessionOut(BaseModel):
    id: str
    created_at: datetime
    user_name: str | None
    personality: Personality
    briefing: Briefing
    materials: list[Material]
    messages: list[ChatMessageOut]
    speech_engine: SpeechEngine = "browser"


class HealthOut(BaseModel):
    status: Literal["ok"] = "ok"
    chat_model: str
    briefing_model: str
    credentials_configured: bool
    speech_engine: SpeechEngine = "browser"


class ExtractedDocument(BaseModel):
    filename: str
    text: str
    characters: int


# --------------------------------------------------------------------------- WebSocket protocol
# Client -> server events.


class StartEvent(BaseModel):
    """The participant joined: the client opens the meeting (ignored if it already started)."""

    type: Literal["start"]


class UserMessageEvent(BaseModel):
    type: Literal["user_message"]
    text: str = Field(min_length=1, max_length=MAX_UTTERANCE_CHARS)
    source: Literal["speech", "typed"] = "speech"

    @field_validator("text")
    @classmethod
    def _text_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("text must not be blank")
        return value


class InterruptEvent(BaseModel):
    """The participant cut the client off. `spoken_text` is what was actually heard."""

    type: Literal["interrupt"]
    message_id: str
    spoken_text: str = Field(default="", max_length=MAX_MATERIAL_CHARS)


class ShareMaterialEvent(BaseModel):
    type: Literal["share_material"]
    material: MaterialIn


class PingEvent(BaseModel):
    type: Literal["ping"]


ClientEvent = Annotated[
    Union[StartEvent, UserMessageEvent, InterruptEvent, ShareMaterialEvent, PingEvent],
    Field(discriminator="type"),
]
client_event_adapter: TypeAdapter[ClientEvent] = TypeAdapter(ClientEvent)
