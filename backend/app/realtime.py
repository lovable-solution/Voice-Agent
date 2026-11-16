"""The live meeting: a WebSocket per session that streams the client's replies.

Protocol (JSON messages)

client -> server
    {"type": "start"}                                     participant joined; client opens the meeting
    {"type": "user_message", "text": "...", "source": "speech" | "typed"}
    {"type": "interrupt", "message_id": "...", "spoken_text": "..."}
    {"type": "share_material", "material": {"kind": "...", "title": "...", "content": "..."}}
    {"type": "ping"}

server -> client
    {"type": "ready", "session": {...}}                   full session state, sent on connect
    {"type": "message_saved", "message": {...}}           a participant turn was recorded
    {"type": "material_added", "material": {...}, "message": {...}}
    {"type": "assistant_start", "message_id": "..."}
    {"type": "assistant_delta", "message_id": "...", "text": "..."}
    {"type": "assistant_end", "message_id": "...", "text": "...", "error": null | "..."}
    {"type": "error", "message": "...", "code": "...", "retryable": bool}
    {"type": "pong"}

Turn-taking rules
    * A new participant turn (speech, typed text, or a shared document) cancels any reply
      still being generated.
    * The browser reports how much of an interrupted reply was actually spoken; the stored
      reply is cut down to that, ending in "—", so the model's view of the conversation
      matches what the participant heard.
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import aclosing
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from .llm import LLM, LLMError, LLMRefusalError
from .prompts import default_title, interrupted_text, join_event_text, shared_material_text, to_api_messages
from .schemas import (
    InterruptEvent,
    Material,
    PingEvent,
    ShareMaterialEvent,
    StartEvent,
    UserMessageEvent,
    client_event_adapter,
)
from .store import ChatMessage, Session, new_id, utcnow

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_SHARED_MATERIALS = 20

# Application close codes (4000-4999 are free for application use).
CLOSE_NOT_FOUND = 4404
CLOSE_FORBIDDEN_ORIGIN = 4403
CLOSE_REPLACED = 4409


class _ClientGone(Exception):
    """The socket closed while we were sending."""


def _origin_allowed(websocket: WebSocket) -> bool:
    """Reject cross-site WebSocket hijacking: only our own pages may connect."""
    origin = websocket.headers.get("origin")
    if not origin:
        return True  # not a browser
    if origin in websocket.app.state.settings.cors_origins:
        return True
    return urlsplit(origin).netloc == websocket.headers.get("host")


@router.websocket("/api/sessions/{session_id}/ws")
async def meeting_socket(websocket: WebSocket, session_id: str) -> None:
    if not _origin_allowed(websocket):
        await websocket.close(code=CLOSE_FORBIDDEN_ORIGIN)
        return
    session: Session | None = websocket.app.state.store.get(session_id)
    await websocket.accept()
    if session is None:
        await websocket.send_json({"type": "error", "code": "not_found", "message": "Meeting session not found.", "retryable": False})
        await websocket.close(code=CLOSE_NOT_FOUND)
        return
    await MeetingConnection(websocket, session, websocket.app.state.llm).run()


class MeetingConnection:
    def __init__(self, websocket: WebSocket, session: Session, llm: LLM) -> None:
        self.ws = websocket
        self.session = session
        self.llm = llm
        self._send_lock = asyncio.Lock()
        self._closed = False
        self._task: asyncio.Task[None] | None = None
        self._reply: ChatMessage | None = None

    # ------------------------------------------------------------------ lifecycle

    async def run(self) -> None:
        previous = self.session.connection
        self.session.connection = self
        if previous is not None:
            await previous.shutdown(code=CLOSE_REPLACED, reason="The meeting was opened in another window.")
        try:
            await self._send({"type": "ready", "session": self.session.to_out().model_dump(mode="json")})
            while True:
                await self._dispatch(await self.ws.receive_text())
        except (WebSocketDisconnect, _ClientGone, RuntimeError):
            pass  # RuntimeError: receiving after the socket was closed from our side
        finally:
            # Bookkeeping first, without awaiting, so it happens even if this task is being cancelled.
            self._closed = True
            if self.session.connection is self:
                self.session.connection = None
            await self._cancel_reply(spoken_text=None)

    async def shutdown(self, *, code: int, reason: str) -> None:
        """Stop this connection from the outside (replaced by a new one, or the session was deleted)."""
        await self._cancel_reply(spoken_text=None)
        if not self._closed:
            self._closed = True
            try:
                await self.ws.close(code=code, reason=reason)
            except RuntimeError:
                pass  # already closing

    # ------------------------------------------------------------------ sending

    async def _send(self, payload: dict[str, Any]) -> None:
        if self._closed:
            raise _ClientGone
        async with self._send_lock:
            try:
                await self.ws.send_text(json.dumps(payload))
            except (WebSocketDisconnect, RuntimeError, OSError) as exc:
                self._closed = True
                raise _ClientGone from exc

    async def _send_error(self, message: str, *, code: str, retryable: bool = False) -> None:
        await self._send({"type": "error", "code": code, "message": message, "retryable": retryable})

    # ------------------------------------------------------------------ incoming events

    async def _dispatch(self, raw: str) -> None:
        try:
            event = client_event_adapter.validate_json(raw)
        except ValidationError as exc:
            first = exc.errors()[0] if exc.errors() else {}
            where = ".".join(str(part) for part in first.get("loc", ()))
            detail = f"{where}: {first.get('msg')}" if where else str(first.get("msg", "invalid message"))
            await self._send_error(f"Invalid message ({detail}).", code="bad_request")
            return

        if isinstance(event, StartEvent):
            await self._on_start()
        elif isinstance(event, UserMessageEvent):
            await self._on_user_message(event)
        elif isinstance(event, InterruptEvent):
            await self._on_interrupt(event)
        elif isinstance(event, ShareMaterialEvent):
            await self._on_share_material(event)
        elif isinstance(event, PingEvent):
            await self._send({"type": "pong"})

    async def _on_start(self) -> None:
        session = self.session
        if session.started:
            return  # reconnect: the client already received the history in `ready`
        session.messages.append(ChatMessage(role="user", kind="event", content=join_event_text(session.user_name)))
        opening = session.briefing.opening_line.strip()
        if not opening:
            self._start_reply()
            return
        # The opening line was written during the briefing, so the meeting starts instantly.
        message = ChatMessage(role="assistant", kind="reply", content=opening)
        session.messages.append(message)
        await self._send({"type": "assistant_start", "message_id": message.id})
        await self._send({"type": "assistant_delta", "message_id": message.id, "text": opening})
        await self._send({"type": "assistant_end", "message_id": message.id, "text": opening, "error": None})

    async def _on_user_message(self, event: UserMessageEvent) -> None:
        await self._cancel_reply(spoken_text=None)
        message = ChatMessage(role="user", kind=event.source, content=event.text)
        self.session.messages.append(message)
        await self._send({"type": "message_saved", "message": message.to_out().model_dump(mode="json")})
        self._start_reply()

    async def _on_interrupt(self, event: InterruptEvent) -> None:
        messages = self.session.messages
        target = messages[-1] if messages else None
        # Only the latest turn can be cut short; earlier history is never rewritten.
        if target is None or target.id != event.message_id or target.role != "assistant":
            return
        if target is self._reply:
            await self._cancel_reply(spoken_text=event.spoken_text)
        else:
            target.content = interrupted_text(event.spoken_text)
            target.interrupted = True

    async def _on_share_material(self, event: ShareMaterialEvent) -> None:
        session = self.session
        if sum(m.shared_during_meeting for m in session.materials) >= MAX_SHARED_MATERIALS:
            await self._send_error("You've shared the maximum number of documents for this meeting.", code="limit")
            return
        await self._cancel_reply(spoken_text=None)
        material = Material(
            id=new_id("mat"),
            kind=event.material.kind,
            title=default_title(event.material),
            content=event.material.content,
            shared_during_meeting=True,
            added_at=utcnow(),
        )
        session.materials.append(material)
        message = ChatMessage(role="user", kind="material", content=shared_material_text(material), material_id=material.id)
        session.messages.append(message)
        await self._send(
            {
                "type": "material_added",
                "material": material.model_dump(mode="json"),
                "message": message.to_out().model_dump(mode="json"),
            }
        )
        self._start_reply()

    # ------------------------------------------------------------------ replies

    def _start_reply(self) -> None:
        history = to_api_messages(self.session.messages)
        reply = ChatMessage(role="assistant", kind="reply", content="")
        self.session.messages.append(reply)
        self._reply = reply
        self._task = asyncio.create_task(self._stream_reply(reply, history))

    async def _stream_reply(self, reply: ChatMessage, history: list[dict[str, str]]) -> None:
        error: LLMError | None = None
        try:
            await self._send({"type": "assistant_start", "message_id": reply.id})
            # aclosing: on cancellation the model stream is closed right away, which stops
            # generation instead of leaving it to the garbage collector.
            async with aclosing(self.llm.stream_reply(system=self.session.system_prompt, messages=history)) as deltas:
                async for delta in deltas:
                    reply.content += delta
                    await self._send({"type": "assistant_delta", "message_id": reply.id, "text": delta})
        except LLMError as exc:
            error = exc
        except _ClientGone:
            return  # run() finalizes the reply as interrupted
        # CancelledError propagates: whoever cancelled the task finalizes the reply.

        if self._reply is reply:
            self._reply = None
            self._task = None

        if error is None:
            reply.content = reply.content.strip()
        elif isinstance(error, LLMRefusalError) or not reply.content.strip():
            reply.content = ""  # discard a declined or empty turn
        else:
            reply.content = interrupted_text(reply.content)  # partial reply, cut off by the failure
            reply.interrupted = True
        if not reply.content and reply in self.session.messages:
            self.session.messages.remove(reply)

        try:
            await self._send(
                {
                    "type": "assistant_end",
                    "message_id": reply.id,
                    "text": reply.content,
                    "error": error.message if error else None,
                }
            )
            if error is not None:
                await self._send_error(error.message, code="llm_error", retryable=error.retryable)
        except _ClientGone:
            pass

    async def _cancel_reply(self, *, spoken_text: str | None) -> None:
        """Stop the reply in progress, keeping only what the participant heard.

        With `spoken_text=None` (a new turn arrived without an explicit interrupt, or the
        socket closed) everything generated so far is kept.
        """
        task, reply = self._task, self._reply
        self._task = self._reply = None
        if task is None or reply is None:
            return
        # Once cancel() is requested the task appends nothing more, so the reply can be
        # finalized right away; then wait for the model stream to close.
        task.cancel()
        heard = reply.content if spoken_text is None else spoken_text
        reply.content = interrupted_text(heard)
        reply.interrupted = True
        await asyncio.wait({task})
