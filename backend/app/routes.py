"""REST endpoints: health, meeting sessions, and document text extraction."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, UploadFile, status
from fastapi.concurrency import run_in_threadpool

from .config import Settings
from .documents import DocumentError, extract_text
from .llm import LLM, LLMError
from .prompts import BRIEFING_SYSTEM, build_briefing_prompt, build_meeting_system_prompt, default_title
from .schemas import MAX_MATERIAL_CHARS, ExtractedDocument, HealthOut, Material, SessionCreate, SessionOut
from .store import Session, SessionStore, new_id, utcnow

router = APIRouter(prefix="/api")


def get_store(request: Request) -> SessionStore:
    return request.app.state.store


def get_llm(request: Request) -> LLM:
    return request.app.state.llm


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


def _get_session_or_404(store: SessionStore, session_id: str) -> Session:
    session = store.get(session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meeting session not found.")
    return session


@router.get("/health", response_model=HealthOut)
async def health(llm: LLM = Depends(get_llm), settings: Settings = Depends(get_app_settings)) -> HealthOut:
    return HealthOut(
        chat_model=settings.chat_model,
        briefing_model=settings.briefing_model,
        credentials_configured=bool(getattr(llm, "credentials_configured", True)),
    )


@router.post("/sessions", response_model=SessionOut, status_code=status.HTTP_201_CREATED)
async def create_session(
    body: SessionCreate,
    store: SessionStore = Depends(get_store),
    llm: LLM = Depends(get_llm),
) -> SessionOut:
    """Have the client study the material, then open a meeting session."""
    prompt = build_briefing_prompt(
        body.materials,
        personality=body.personality,
        user_name=body.user_name,
        user_background=body.user_background,
        client_name=body.client_name,
    )
    try:
        briefing = await llm.generate_briefing(system=BRIEFING_SYSTEM, prompt=prompt)
    except LLMError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    if body.client_name:
        briefing.persona.name = body.client_name

    now = utcnow()
    materials = [
        Material(id=new_id("mat"), kind=m.kind, title=default_title(m), content=m.content, added_at=now)
        for m in body.materials
    ]
    session = Session(
        briefing=briefing,
        materials=materials,
        personality=body.personality,
        user_name=body.user_name,
        user_background=body.user_background,
        system_prompt=build_meeting_system_prompt(
            briefing,
            materials,
            personality=body.personality,
            user_name=body.user_name,
            user_background=body.user_background,
        ),
    )
    store.add(session)
    return session.to_out()


@router.get("/sessions/{session_id}", response_model=SessionOut)
async def get_session(session_id: str, store: SessionStore = Depends(get_store)) -> SessionOut:
    return _get_session_or_404(store, session_id).to_out()


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(session_id: str, store: SessionStore = Depends(get_store)) -> Response:
    session = _get_session_or_404(store, session_id)
    if session.connection is not None:
        await session.connection.shutdown(code=4410, reason="Meeting ended")
    store.delete(session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/documents/extract", response_model=ExtractedDocument)
async def extract_document(file: UploadFile, settings: Settings = Depends(get_app_settings)) -> ExtractedDocument:
    """Turn an uploaded PDF, Word, HTML, Markdown, or text file into plain text."""
    max_bytes = settings.max_upload_mb * 1024 * 1024
    data = await file.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"File is larger than {settings.max_upload_mb} MB.",
        )
    filename = file.filename or "document"
    try:
        text = await run_in_threadpool(extract_text, filename, data)
    except DocumentError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc

    if len(text) > MAX_MATERIAL_CHARS:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=(
                f"That document has {len(text):,} characters of text; the limit is {MAX_MATERIAL_CHARS:,}. "
                "Paste the most relevant part instead."
            ),
        )
    return ExtractedDocument(filename=filename, text=text, characters=len(text))
