from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from websockets.asyncio.server import ServerConnection, serve
from websockets.http11 import Request

from app.config import Settings
from app.speech import DeepgramFlux, SpeechError, SpeechRelay, TurnSettings, speech_keyterms, status_error

from .conftest import JOB_POSTING, FakeSpeech, make_briefing, turn_info

CHUNK = bytes(2560)  # 80 ms of 16 kHz 16-bit audio


def speech_url(session_id: str, query: str = "") -> str:
    return f"/api/sessions/{session_id}/speech{query}"


def create_session(client: TestClient) -> dict[str, Any]:
    response = client.post(
        "/api/sessions",
        json={"materials": [{"kind": "job_posting", "content": JOB_POSTING}], "user_name": "Alex Kim"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def expect_close(ws: Any, code: int) -> None:
    with pytest.raises(WebSocketDisconnect) as closed:
        ws.receive_json()
    assert closed.value.code == code


# --------------------------------------------------------------------------- the relay


def test_sessions_use_deepgram_when_it_is_configured(speech_client: TestClient, fake_speech: FakeSpeech) -> None:
    session = create_session(speech_client)
    assert session["speech_engine"] == "deepgram"
    assert speech_client.get("/api/health").json()["speech_engine"] == "deepgram"

    with speech_client.websocket_connect(speech_url(session["id"])) as ws:
        assert ws.receive_json() == {"type": "ready"}

    stream = fake_speech.streams[0]
    # The people in the meeting come first, then the briefing's terms.
    assert stream.keyterms == ["Alex Kim", "Alex", "Jordan Lee", "Jordan", "FinFlow", "React", "TypeScript", "charting libraries"]
    assert stream.turn == TurnSettings()
    assert stream.closed  # the browser left, so the Deepgram stream was closed


def test_relays_audio_up_and_turns_down(speech_client: TestClient, fake_speech: FakeSpeech) -> None:
    session = create_session(speech_client)
    fake_speech.script = [
        [turn_info("Update", "")],  # silence: Flux reports it, the browser doesn't need it
        [turn_info("StartOfTurn", "We could"), turn_info("Update", "We could"), turn_info("Update", "We could start")],
        [turn_info("EndOfTurn", "We could start in March.")],
    ]
    with speech_client.websocket_connect(speech_url(session["id"])) as ws:
        assert ws.receive_json() == {"type": "ready"}
        ws.send_bytes(CHUNK)
        ws.send_bytes(CHUNK)
        assert ws.receive_json() == {"type": "turn", "event": "StartOfTurn", "turn_index": 0, "transcript": "We could"}
        # The repeated Update (Flux sends one every ~0.25 s, even in silence) was dropped.
        assert ws.receive_json() == {"type": "turn", "event": "Update", "turn_index": 0, "transcript": "We could start"}
        ws.send_bytes(CHUNK)
        assert ws.receive_json() == {
            "type": "turn",
            "event": "EndOfTurn",
            "turn_index": 0,
            "transcript": "We could start in March.",
        }
    assert fake_speech.streams[0].audio == [CHUNK, CHUNK, CHUNK]


def test_control_messages_and_turn_settings(speech_client: TestClient, fake_speech: FakeSpeech) -> None:
    session = create_session(speech_client)
    with speech_client.websocket_connect(speech_url(session["id"], "?eot_threshold=0.75&eot_timeout_ms=99999999")) as ws:
        assert ws.receive_json() == {"type": "ready"}
        ws.send_json({"type": "listening", "on": True})
        ws.send_json({"type": "end_turn"})
        ws.send_json({"type": "configure", "eot_threshold": 2, "eot_timeout_ms": "soon"})
        ws.send_text("not json")  # ignored
        fake_speech.script = [[turn_info("Update", "ok")]]
        ws.send_bytes(CHUNK)
        ws.receive_json()  # messages are handled in order, so everything above was too

    stream = fake_speech.streams[0]
    assert stream.turn == TurnSettings(eot_threshold=0.75, eot_timeout_ms=60_000)  # clamped to Flux's range
    assert stream.controls == [
        ("listening", True),
        "end_turn",
        ("configure", TurnSettings(eot_threshold=1.0, eot_timeout_ms=5_000)),
    ]


def test_without_deepgram_the_speech_socket_explains_why(client: TestClient, session_id: str) -> None:
    assert client.get(f"/api/sessions/{session_id}").json()["speech_engine"] == "browser"
    with client.websocket_connect(speech_url(session_id)) as ws:
        error = ws.receive_json()
        assert error["code"] == "not_configured"
        assert "DEEPGRAM_API_KEY" in error["message"]
        assert error["retryable"] is False
        expect_close(ws, 4400)


def test_unknown_session(speech_client: TestClient) -> None:
    with speech_client.websocket_connect(speech_url("ses_missing")) as ws:
        assert ws.receive_json()["code"] == "not_found"
        expect_close(ws, 4404)


def test_a_rejected_key_is_reported_and_not_retried(speech_client: TestClient, fake_speech: FakeSpeech) -> None:
    session = create_session(speech_client)
    fake_speech.open_error = status_error(401, b'{"err_msg": "Invalid credentials."}')
    with speech_client.websocket_connect(speech_url(session["id"])) as ws:
        error = ws.receive_json()
        assert error == {
            "type": "error",
            "code": "auth",
            "message": "Deepgram rejected the API key. Check DEEPGRAM_API_KEY in backend/.env.",
            "retryable": False,
        }
        expect_close(ws, 4400)


def test_an_unreachable_service_can_be_retried(speech_client: TestClient, fake_speech: FakeSpeech) -> None:
    session = create_session(speech_client)
    fake_speech.open_error = SpeechError("Couldn't reach Deepgram.", code="unavailable", retryable=True)
    with speech_client.websocket_connect(speech_url(session["id"])) as ws:
        assert ws.receive_json()["retryable"] is True
        expect_close(ws, 4503)


def test_a_deepgram_error_mid_stream_ends_it(speech_client: TestClient, fake_speech: FakeSpeech) -> None:
    session = create_session(speech_client)
    fake_speech.script = [[{"type": "Error", "sequence_id": 3, "code": "INTERNAL_SERVER_ERROR", "description": "Overloaded"}]]
    with speech_client.websocket_connect(speech_url(session["id"])) as ws:
        assert ws.receive_json() == {"type": "ready"}
        ws.send_bytes(CHUNK)
        assert ws.receive_json() == {
            "type": "error",
            "code": "deepgram",
            "message": "Deepgram stopped transcribing: Overloaded",
            "retryable": True,
        }
        expect_close(ws, 4503)
    assert fake_speech.streams[0].closed


def test_deepgram_hanging_up_is_reported(speech_client: TestClient, fake_speech: FakeSpeech) -> None:
    session = create_session(speech_client)
    fake_speech.script = [[None]]
    with speech_client.websocket_connect(speech_url(session["id"])) as ws:
        assert ws.receive_json() == {"type": "ready"}
        ws.send_bytes(CHUNK)
        error = ws.receive_json()
        assert (error["code"], error["retryable"]) == ("unavailable", True)
        expect_close(ws, 4503)


def test_a_second_window_replaces_the_first(speech_client: TestClient, fake_speech: FakeSpeech) -> None:
    session = create_session(speech_client)
    with speech_client.websocket_connect(speech_url(session["id"])) as first:
        assert first.receive_json() == {"type": "ready"}
        with speech_client.websocket_connect(speech_url(session["id"])) as second:
            assert second.receive_json() == {"type": "ready"}
            expect_close(first, 4409)
    assert fake_speech.streams[0].closed  # only one Deepgram stream per meeting


def test_ending_the_meeting_closes_the_speech_socket(speech_client: TestClient) -> None:
    session = create_session(speech_client)
    with speech_client.websocket_connect(speech_url(session["id"])) as ws:
        assert ws.receive_json() == {"type": "ready"}
        assert speech_client.delete(f"/api/sessions/{session['id']}").status_code == 204
        expect_close(ws, 4410)


async def test_shutting_down_a_relay_whose_browser_already_left_does_not_fail() -> None:
    # Leaving the meeting closes the browser's socket; "Start a new meeting" then deletes the session.
    class GoneSocket:
        async def close(self, code: int = 1000, reason: str = "") -> None:
            raise WebSocketDisconnect(code=1006)

    session = SimpleNamespace(speech_relay=None)
    relay = SpeechRelay(GoneSocket(), session, FakeSpeech(), TurnSettings())  # type: ignore[arg-type]
    await relay.shutdown(code=4410, reason="Meeting ended")  # must not raise (it used to: HTTP 500)


# --------------------------------------------------------------------------- pieces


def test_keyterms_are_cleaned_deduplicated_and_capped() -> None:
    briefing = make_briefing(
        speech_keyterms=["SQL Server", "sql server", "Shopify, Twilio", "  ERP  ", "x" * 61, *[f"term {i}" for i in range(80)]]
    )
    terms = speech_keyterms(briefing, "Ross Yeager")
    assert terms[:9] == ["Ross Yeager", "Ross", "Jordan Lee", "Jordan", "FinFlow", "SQL Server", "Shopify Twilio", "ERP", "term 0"]
    assert len(terms) == 50
    assert speech_keyterms(make_briefing(speech_keyterms=[]), None) == ["Jordan Lee", "Jordan", "FinFlow"]


def test_turn_settings_are_clamped_to_flux_ranges() -> None:
    assert TurnSettings.parse("0.8", "6000") == TurnSettings(0.8, 6000)
    assert TurnSettings.parse(0.1, 100) == TurnSettings(0.5, 500)
    assert TurnSettings.parse(None, "nan") == TurnSettings()


def test_refused_connections_map_to_clear_errors() -> None:
    assert status_error(403, None).code == "auth"
    assert status_error(402, None).message == "The Deepgram account is out of credit."
    assert status_error(429, None).retryable is True
    assert status_error(503, None).retryable is True
    refused = status_error(400, b'{"err_msg": "Invalid query string."}')
    assert (refused.message, refused.retryable) == ("Deepgram refused the audio stream (HTTP 400): Invalid query string.", False)


def test_flux_url_carries_the_audio_format_turn_settings_and_keyterms() -> None:
    flux = DeepgramFlux(Settings(_env_file=None, deepgram_api_key="key"))
    url = urlsplit(flux.stream_url(["SQL Server", "Ross"], TurnSettings(0.75, 4750)))
    assert f"{url.scheme}://{url.netloc}{url.path}" == "wss://api.deepgram.com/v2/listen"
    assert parse_qs(url.query) == {
        "model": ["flux-general-en"],
        "encoding": ["linear16"],
        "sample_rate": ["16000"],
        "eot_threshold": ["0.75"],
        "eot_timeout_ms": ["4750"],
        "keyterm": ["SQL Server", "Ross"],
    }


# --------------------------------------------------------------------------- the real client, against a local server


async def test_flux_client_speaks_the_deepgram_protocol() -> None:
    seen: dict[str, Any] = {}

    async def deepgram(ws: ServerConnection) -> None:
        seen["auth"] = ws.request.headers["Authorization"]
        seen["path"] = ws.request.path
        await ws.send(json.dumps({"type": "Connected", "request_id": "r1", "sequence_id": 0}))
        seen["audio"] = await ws.recv()
        seen["control"] = json.loads(await ws.recv())
        await ws.send(json.dumps(turn_info("EndOfTurn", "Hello there.")))
        seen["closing"] = json.loads(await ws.recv())

    async with serve(deepgram, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        flux = DeepgramFlux(
            Settings(_env_file=None, deepgram_api_key="secret", deepgram_url=f"ws://127.0.0.1:{port}/v2/listen")
        )
        stream = await flux.open(keyterms=["SQL Server"], turn=TurnSettings())
        events = stream.events()
        assert (await anext(events))["type"] == "Connected"
        await stream.send_audio(CHUNK)
        await stream.end_turn()
        assert (await anext(events))["transcript"] == "Hello there."
        await stream.close()

    assert seen["auth"] == "Token secret"
    assert "keyterm=SQL+Server" in seen["path"]
    assert seen["audio"] == CHUNK
    assert seen["control"] == {"type": "ForceEndTurn"}
    assert seen["closing"] == {"type": "CloseStream"}


async def test_flux_client_reports_a_rejected_key() -> None:
    def reject(connection: ServerConnection, request: Request) -> Any:
        return connection.respond(401, "Unauthorized\n")

    async def never(ws: ServerConnection) -> None:  # pragma: no cover - the handshake is refused
        pass

    async with serve(never, "127.0.0.1", 0, process_request=reject) as server:
        port = server.sockets[0].getsockname()[1]
        flux = DeepgramFlux(Settings(_env_file=None, deepgram_api_key="bad", deepgram_url=f"ws://127.0.0.1:{port}"))
        with pytest.raises(SpeechError) as failure:
            await flux.open(keyterms=[], turn=TurnSettings())
    assert (failure.value.code, failure.value.retryable) == ("auth", False)


async def test_flux_client_reports_an_unreachable_service() -> None:
    flux = DeepgramFlux(Settings(_env_file=None, deepgram_api_key="key", deepgram_url="ws://127.0.0.1:9"))
    with pytest.raises(SpeechError) as failure:
        await flux.open(keyterms=[], turn=TurnSettings())
    assert (failure.value.code, failure.value.retryable) == ("unavailable", True)
