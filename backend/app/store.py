"""In-memory meeting sessions.

Sessions live in process memory: this is a single-user practice tool, and a meeting
only needs to survive as long as the server runs. Swap `SessionStore` for a
database-backed implementation if you need persistence or multiple workers.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Literal

from .schemas import Briefing, ChatMessageOut, Material, MessageKind, Personality, SessionOut

if TYPE_CHECKING:
    from .realtime import MeetingConnection


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class ChatMessage:
    role: Literal["user", "assistant"]
    kind: MessageKind
    content: str
    id: str = field(default_factory=lambda: new_id("msg"))
    created_at: datetime = field(default_factory=utcnow)
    interrupted: bool = False
    material_id: str | None = None

    def to_out(self) -> ChatMessageOut:
        return ChatMessageOut(
            id=self.id,
            role=self.role,
            kind=self.kind,
            content=self.content,
            interrupted=self.interrupted,
            material_id=self.material_id,
            created_at=self.created_at,
        )


@dataclass
class Session:
    briefing: Briefing
    materials: list[Material]
    system_prompt: str
    personality: Personality
    user_name: str | None = None
    user_background: str | None = None
    id: str = field(default_factory=lambda: new_id("ses"))
    created_at: datetime = field(default_factory=utcnow)
    messages: list[ChatMessage] = field(default_factory=list)
    last_active: float = field(default_factory=time.monotonic)
    connection: MeetingConnection | None = None

    @property
    def started(self) -> bool:
        return bool(self.messages)

    def find_message(self, message_id: str) -> ChatMessage | None:
        return next((m for m in reversed(self.messages) if m.id == message_id), None)

    def to_out(self) -> SessionOut:
        return SessionOut(
            id=self.id,
            created_at=self.created_at,
            user_name=self.user_name,
            personality=self.personality,
            briefing=self.briefing,
            materials=self.materials,
            messages=[m.to_out() for m in self.messages],
        )


class SessionStore:
    def __init__(self, ttl_seconds: float, max_sessions: int) -> None:
        self._ttl = ttl_seconds
        self._max = max_sessions
        self._sessions: dict[str, Session] = {}

    def __len__(self) -> int:
        return len(self._sessions)

    def add(self, session: Session) -> None:
        self.purge_expired()
        while len(self._sessions) >= self._max:
            idle = [s for s in self._sessions.values() if s.connection is None] or list(self._sessions.values())
            oldest = min(idle, key=lambda s: s.last_active)
            del self._sessions[oldest.id]
        self._sessions[session.id] = session

    def get(self, session_id: str) -> Session | None:
        session = self._sessions.get(session_id)
        if session is not None:
            session.last_active = time.monotonic()
        return session

    def delete(self, session_id: str) -> Session | None:
        return self._sessions.pop(session_id, None)

    def purge_expired(self) -> None:
        cutoff = time.monotonic() - self._ttl
        for session_id in [
            s.id for s in self._sessions.values() if s.connection is None and s.last_active < cutoff
        ]:
            del self._sessions[session_id]
