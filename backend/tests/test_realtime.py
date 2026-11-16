from __future__ import annotations

import time
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.llm import LLMError, LLMRefusalError

from .conftest import FakeLLM

OPENING = "Hi Alex, thanks for joining. Shall we dive into the dashboard project?"
PARTNERSHIP = "Co-sell our analytics add-on to FinFlow's customers with a 70/30 revenue share."


def ws_url(session_id: str) -> str:
    return f"/api/sessions/{session_id}/ws"


def receive_until(ws: Any, event_type: str) -> list[dict[str, Any]]:
    events = []
    while True:
        event = ws.receive_json()
        events.append(event)
        if event["type"] == event_type:
            return events


def join(ws: Any) -> dict[str, Any]:
    """Read `ready`, start the meeting, and return the opening line's assistant_end."""
    assert ws.receive_json()["type"] == "ready"
    ws.send_json({"type": "start"})
    return receive_until(ws, "assistant_end")[-1]


def barrier(ws: Any) -> None:
    """Events are handled in order, so a pong means everything sent before it was processed."""
    ws.send_json({"type": "ping"})
    receive_until(ws, "pong")


def stored(client: TestClient, session_id: str) -> list[dict[str, Any]]:
    return client.get(f"/api/sessions/{session_id}").json()["messages"]


def test_start_opens_with_the_prepared_line(client: TestClient, session_id: str, fake_llm: FakeLLM) -> None:
    with client.websocket_connect(ws_url(session_id)) as ws:
        ready = ws.receive_json()
        assert ready["type"] == "ready"
        assert ready["session"]["id"] == session_id
        assert ready["session"]["messages"] == []

        ws.send_json({"type": "start"})
        start, delta, end = ws.receive_json(), ws.receive_json(), ws.receive_json()
        assert start["type"] == "assistant_start"
        assert delta == {"type": "assistant_delta", "message_id": start["message_id"], "text": OPENING}
        assert end == {"type": "assistant_end", "message_id": start["message_id"], "text": OPENING, "error": None}

        ws.send_json({"type": "start"})  # a second start (e.g. after a reconnect) is ignored
        barrier(ws)

    assert fake_llm.reply_calls == []  # the opening needs no model call
    messages = stored(client, session_id)
    assert [(m["role"], m["kind"], m["content"]) for m in messages] == [
        ("user", "event", "[Alex Kim joined the call.]"),
        ("assistant", "reply", OPENING),
    ]


def test_user_turn_streams_a_reply_with_full_history(client: TestClient, session_id: str, fake_llm: FakeLLM) -> None:
    fake_llm.replies = ["Great. What's your timeline?"]
    with client.websocket_connect(ws_url(session_id)) as ws:
        join(ws)
        ws.send_json({"type": "user_message", "text": "  I've built three dashboards like this. ", "source": "speech"})
        events = receive_until(ws, "assistant_end")

    saved, start = events[0], events[1]
    assert saved["type"] == "message_saved"
    assert saved["message"]["content"] == "I've built three dashboards like this."
    assert start["type"] == "assistant_start"
    assert "".join(e["text"] for e in events if e["type"] == "assistant_delta") == "Great. What's your timeline?"
    assert events[-1]["text"] == "Great. What's your timeline?"
    assert events[-1]["error"] is None

    call = fake_llm.reply_calls[0]
    assert call["system"] == client.app.state.store.get(session_id).system_prompt
    assert call["messages"] == [
        {"role": "user", "content": "[Alex Kim joined the call.]"},
        {"role": "assistant", "content": OPENING},
        {"role": "user", "content": "I've built three dashboards like this."},
    ]
    assert [m["kind"] for m in stored(client, session_id)] == ["event", "reply", "speech", "reply"]


def test_interrupt_keeps_only_what_was_heard(client: TestClient, session_id: str, fake_llm: FakeLLM) -> None:
    fake_llm.delay = 0.03
    fake_llm.replies = ["one two three four five six seven eight nine ten eleven twelve", "Sure, go ahead."]
    with client.websocket_connect(ws_url(session_id)) as ws:
        join(ws)
        ws.send_json({"type": "user_message", "text": "Hello"})
        receive_until(ws, "assistant_start")
        first_delta = ws.receive_json()
        interrupted_id = first_delta["message_id"]

        ws.send_json({"type": "interrupt", "message_id": interrupted_id, "spoken_text": "one two"})
        ws.send_json({"type": "user_message", "text": "Sorry, quick question", "source": "typed"})
        events = receive_until(ws, "assistant_end")

    assert events[-1]["message_id"] != interrupted_id
    assert events[-1]["text"] == "Sure, go ahead."
    # The cancelled stream was closed, and the next turn sees the reply cut where it was heard.
    assert fake_llm.closed_streams == 2
    history = fake_llm.reply_calls[1]["messages"]
    assert history[-2:] == [
        {"role": "assistant", "content": "one two—"},
        {"role": "user", "content": "Sorry, quick question"},
    ]
    interrupted = next(m for m in stored(client, session_id) if m["id"] == interrupted_id)
    assert interrupted["interrupted"] is True


def test_interrupting_a_finished_reply_truncates_it(client: TestClient, session_id: str) -> None:
    with client.websocket_connect(ws_url(session_id)) as ws:
        opening_id = join(ws)["message_id"]
        ws.send_json({"type": "interrupt", "message_id": opening_id, "spoken_text": "Hi Alex, thanks for joining."})
        barrier(ws)

    last = stored(client, session_id)[-1]
    assert last["content"] == "Hi Alex, thanks for joining.—"
    assert last["interrupted"] is True


def test_interrupt_before_anything_was_spoken(client: TestClient, session_id: str, fake_llm: FakeLLM) -> None:
    fake_llm.replies = ["Okay.", "Noted."]
    with client.websocket_connect(ws_url(session_id)) as ws:
        join(ws)
        ws.send_json({"type": "user_message", "text": "Hello"})
        reply_id = receive_until(ws, "assistant_end")[-1]["message_id"]
        ws.send_json({"type": "interrupt", "message_id": reply_id, "spoken_text": ""})
        ws.send_json({"type": "user_message", "text": "Actually, one more thing"})
        receive_until(ws, "assistant_end")

    assert fake_llm.reply_calls[1]["messages"][-2:] == [
        {"role": "assistant", "content": "—"},
        {"role": "user", "content": "Actually, one more thing"},
    ]


def test_stale_interrupts_never_rewrite_earlier_turns(client: TestClient, session_id: str) -> None:
    with client.websocket_connect(ws_url(session_id)) as ws:
        opening_id = join(ws)["message_id"]
        ws.send_json({"type": "user_message", "text": "Hello"})
        receive_until(ws, "assistant_end")
        ws.send_json({"type": "interrupt", "message_id": opening_id, "spoken_text": "Hi"})
        ws.send_json({"type": "interrupt", "message_id": "msg_unknown", "spoken_text": "Hi"})
        barrier(ws)

    messages = stored(client, session_id)
    assert messages[1]["content"] == OPENING
    assert not any(m["interrupted"] for m in messages)


def test_shared_material_is_learned_mid_meeting(client: TestClient, session_id: str, fake_llm: FakeLLM) -> None:
    fake_llm.replies = ["Thanks for sending that over. A seventy thirty split is interesting."]
    system_before = client.app.state.store.get(session_id).system_prompt
    with client.websocket_connect(ws_url(session_id)) as ws:
        join(ws)
        ws.send_json(
            {"type": "share_material", "material": {"kind": "partnership", "title": "Co-selling", "content": PARTNERSHIP}}
        )
        events = receive_until(ws, "assistant_end")

    added = events[0]
    assert added["type"] == "material_added"
    assert added["material"]["title"] == "Co-selling"
    assert added["material"]["shared_during_meeting"] is True
    assert added["message"]["kind"] == "material"
    assert added["message"]["material_id"] == added["material"]["id"]

    call = fake_llm.reply_calls[0]
    turn = call["messages"][-1]
    assert turn["role"] == "user"
    assert turn["content"].startswith("[Shared a document in the meeting: “Co-selling” (partnership ideas)]")
    assert '<shared_document kind="partnership" title="Co-selling">' in turn["content"]
    assert PARTNERSHIP in turn["content"]
    # The system prompt stays frozen; new knowledge arrives as a conversation turn.
    assert call["system"] == system_before

    session = client.get(f"/api/sessions/{session_id}").json()
    assert [m["shared_during_meeting"] for m in session["materials"]] == [False, True]


def test_invalid_messages_get_an_error_and_keep_the_connection(client: TestClient, session_id: str) -> None:
    with client.websocket_connect(ws_url(session_id)) as ws:
        ws.receive_json()
        for bad in ("not json", '{"type": "dance"}', '{"type": "user_message", "text": "   "}'):
            ws.send_text(bad)
            error = ws.receive_json()
            assert error["type"] == "error"
            assert error["code"] == "bad_request"
        barrier(ws)


def test_llm_failure_before_output(client: TestClient, session_id: str, fake_llm: FakeLLM) -> None:
    fake_llm.replies = [LLMError("Rate limited, try again.", status_code=429, retryable=True)]
    with client.websocket_connect(ws_url(session_id)) as ws:
        join(ws)
        ws.send_json({"type": "user_message", "text": "Hello"})
        events = receive_until(ws, "error")

    end = next(e for e in events if e["type"] == "assistant_end")
    assert end["text"] == ""
    assert end["error"] == "Rate limited, try again."
    assert events[-1] == {"type": "error", "code": "llm_error", "message": "Rate limited, try again.", "retryable": True}
    assert [m["kind"] for m in stored(client, session_id)] == ["event", "reply", "speech"]  # empty reply dropped


def test_llm_failure_mid_reply_keeps_the_partial_text(client: TestClient, session_id: str, fake_llm: FakeLLM) -> None:
    fake_llm.replies = [("So the budget is", LLMError("Connection lost.", status_code=503, retryable=True))]
    with client.websocket_connect(ws_url(session_id)) as ws:
        join(ws)
        ws.send_json({"type": "user_message", "text": "What's the budget?"})
        receive_until(ws, "error")

    last = stored(client, session_id)[-1]
    assert last["content"] == "So the budget is—"
    assert last["interrupted"] is True


def test_refusal_discards_the_partial_reply(client: TestClient, session_id: str, fake_llm: FakeLLM) -> None:
    fake_llm.replies = [("Well, I", LLMRefusalError("Claude declined to continue."))]
    with client.websocket_connect(ws_url(session_id)) as ws:
        join(ws)
        ws.send_json({"type": "user_message", "text": "Hello"})
        events = receive_until(ws, "error")

    assert next(e for e in events if e["type"] == "assistant_end")["text"] == ""
    assert stored(client, session_id)[-1]["kind"] == "speech"


def test_disconnect_mid_reply_marks_it_interrupted(client: TestClient, session_id: str, fake_llm: FakeLLM) -> None:
    fake_llm.delay = 0.05
    fake_llm.replies = ["one two three four five six seven eight nine ten"]
    with client.websocket_connect(ws_url(session_id)) as ws:
        join(ws)
        ws.send_json({"type": "user_message", "text": "Hello"})
        receive_until(ws, "assistant_delta")

    store = client.app.state.store
    deadline = time.monotonic() + 3
    while store.get(session_id).connection is not None and time.monotonic() < deadline:
        time.sleep(0.02)
    last = store.get(session_id).messages[-1]
    assert last.interrupted is True
    assert last.content.endswith("—")
    assert "ten" not in last.content


def test_unknown_session_is_rejected(client: TestClient) -> None:
    with client.websocket_connect(ws_url("ses_missing")) as ws:
        assert ws.receive_json()["code"] == "not_found"
        with pytest.raises(WebSocketDisconnect) as info:
            ws.receive_json()
    assert info.value.code == 4404


def test_cross_site_origin_is_rejected(client: TestClient, session_id: str) -> None:
    with pytest.raises(WebSocketDisconnect) as info:
        with client.websocket_connect(ws_url(session_id), headers={"origin": "https://evil.example"}) as ws:
            ws.receive_json()
    assert info.value.code == 4403

    with client.websocket_connect(ws_url(session_id), headers={"origin": "http://localhost:5173"}) as ws:
        assert ws.receive_json()["type"] == "ready"


def test_new_connection_replaces_the_old_one(client: TestClient, session_id: str) -> None:
    with client.websocket_connect(ws_url(session_id)) as first:
        first.receive_json()
        with client.websocket_connect(ws_url(session_id)) as second:
            assert second.receive_json()["type"] == "ready"
            with pytest.raises(WebSocketDisconnect) as info:
                first.receive_json()
            assert info.value.code == 4409
            barrier(second)


def test_deleting_the_session_closes_the_meeting(client: TestClient, session_id: str) -> None:
    with client.websocket_connect(ws_url(session_id)) as ws:
        ws.receive_json()
        assert client.delete(f"/api/sessions/{session_id}").status_code == 204
        with pytest.raises(WebSocketDisconnect) as info:
            ws.receive_json()
    assert info.value.code == 4410
