from __future__ import annotations

import io

from docx import Document
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from app.llm import LLMError, LLMRefusalError

from .conftest import JOB_POSTING, FakeLLM

PARTNERSHIP = "Co-sell our analytics add-on to FinFlow's customers with a 70/30 revenue share."


def test_health_reports_models_and_credentials(client: TestClient) -> None:
    body = client.get("/api/health").json()
    assert body == {
        "status": "ok",
        "chat_model": "claude-opus-5-5",
        "briefing_model": "claude-opus-5-5",
        "credentials_configured": True,
        "speech_engine": "browser",  # no Deepgram key: the browser transcribes
    }


def test_create_session_learns_the_material(client: TestClient, fake_llm: FakeLLM) -> None:
    response = client.post(
        "/api/sessions",
        json={
            "materials": [
                {"kind": "job_posting", "content": JOB_POSTING},
                {"kind": "partnership", "title": "Co-selling idea", "content": PARTNERSHIP},
            ],
            "user_name": "  Alex Kim ",
            "user_background": "Freelance React developer, 6 years.",
            "personality": "demanding",
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()

    assert body["id"].startswith("ses_")
    assert body["user_name"] == "Alex Kim"
    assert body["personality"] == "demanding"
    assert body["briefing"]["persona"]["name"] == "Jordan Lee"
    assert body["messages"] == []
    assert [m["title"] for m in body["materials"]] == ["Senior React Developer (contract, 3 months)", "Co-selling idea"]
    assert not any(m["shared_during_meeting"] for m in body["materials"])

    # The briefing request carries every piece of material and the participant's details.
    prompt = fake_llm.briefing_calls[0]["prompt"]
    assert JOB_POSTING in prompt
    assert PARTNERSHIP in prompt
    assert "Freelance React developer, 6 years." in prompt
    assert "greet Alex by name" in prompt
    assert "negotiate hard" in prompt  # demanding temperament


def test_client_name_override_is_enforced(client: TestClient, fake_llm: FakeLLM) -> None:
    response = client.post(
        "/api/sessions",
        json={"materials": [{"kind": "partnership", "content": PARTNERSHIP}], "client_name": "Priya Raman"},
    )
    assert response.status_code == 201
    assert response.json()["briefing"]["persona"]["name"] == "Priya Raman"
    assert "The client's name is Priya Raman." in fake_llm.briefing_calls[0]["prompt"]


def test_create_session_validates_input(client: TestClient) -> None:
    assert client.post("/api/sessions", json={"materials": []}).status_code == 422
    assert client.post("/api/sessions", json={"materials": [{"kind": "job_posting", "content": "   "}]}).status_code == 422
    assert client.post("/api/sessions", json={"materials": [{"kind": "resume", "content": "x"}]}).status_code == 422
    too_long = "x" * 60_001
    assert client.post("/api/sessions", json={"materials": [{"kind": "notes", "content": too_long}]}).status_code == 422


def test_create_session_surfaces_llm_errors(client: TestClient, fake_llm: FakeLLM) -> None:
    fake_llm.briefing_error = LLMError("No Anthropic API key is configured.", status_code=503)
    response = client.post("/api/sessions", json={"materials": [{"kind": "job_posting", "content": JOB_POSTING}]})
    assert response.status_code == 503
    assert response.json()["detail"] == "No Anthropic API key is configured."

    fake_llm.briefing_error = LLMRefusalError("Claude declined.")
    response = client.post("/api/sessions", json={"materials": [{"kind": "job_posting", "content": JOB_POSTING}]})
    assert response.status_code == 422


def test_get_and_delete_session(client: TestClient, session_id: str) -> None:
    assert client.get(f"/api/sessions/{session_id}").status_code == 200
    assert client.delete(f"/api/sessions/{session_id}").status_code == 204
    assert client.get(f"/api/sessions/{session_id}").status_code == 404
    assert client.delete(f"/api/sessions/{session_id}").status_code == 404


# --------------------------------------------------------------------------- documents


def _upload(client: TestClient, name: str, data: bytes):
    return client.post("/api/documents/extract", files={"file": (name, data)})


def test_extract_plain_text_and_markdown(client: TestClient) -> None:
    response = _upload(client, "posting.md", "# Senior React Developer\r\n\r\n\r\n\r\nBudget:   $18k\n".encode())
    assert response.status_code == 200
    text = "# Senior React Developer\n\nBudget: $18k"
    assert response.json() == {"filename": "posting.md", "text": text, "characters": len(text)}


def test_extract_docx(client: TestClient) -> None:
    document = Document()
    document.add_paragraph("Partnership proposal")
    document.add_paragraph("Revenue share: 70/30")
    table = document.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = "Term"
    table.rows[0].cells[1].text = "12 months"
    buffer = io.BytesIO()
    document.save(buffer)

    response = _upload(client, "proposal.docx", buffer.getvalue())
    assert response.status_code == 200
    text = response.json()["text"]
    assert "Partnership proposal" in text
    assert "Revenue share: 70/30" in text
    assert "Term | 12 months" in text


def test_extract_html_skips_scripts(client: TestClient) -> None:
    html = b"<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Job</h1><ul><li>React</li><li>TypeScript</li></ul></body></html>"
    response = _upload(client, "job.html", html)
    assert response.status_code == 200
    text = response.json()["text"]
    assert "alert" not in text and "p{}" not in text
    assert "Job" in text and "- React" in text and "- TypeScript" in text


def test_extract_rejects_bad_files(client: TestClient) -> None:
    unsupported = _upload(client, "image.png", b"\x89PNG")
    assert unsupported.status_code == 422
    assert "Unsupported file type" in unsupported.json()["detail"]

    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    buffer = io.BytesIO()
    writer.write(buffer)
    empty_pdf = _upload(client, "scan.pdf", buffer.getvalue())
    assert empty_pdf.status_code == 422
    assert "No text found" in empty_pdf.json()["detail"]

    broken_pdf = _upload(client, "broken.pdf", b"not really a pdf")
    assert broken_pdf.status_code == 422

    too_big = _upload(client, "big.txt", b"x" * (1024 * 1024 + 1))
    assert too_big.status_code == 413

    too_much_text = _upload(client, "long.txt", b"word " * 13_000)
    assert too_much_text.status_code == 413
    assert "limit is 60,000" in too_much_text.json()["detail"]
