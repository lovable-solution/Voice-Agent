"""FastAPI application factory.

Run in development with:  uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import realtime, routes, speech
from .config import Settings, get_settings
from .llm import LLM, AnthropicLLM
from .speech import DeepgramFlux, SpeechToText
from .store import SessionStore

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


def create_app(
    settings: Settings | None = None,
    llm: LLM | None = None,
    speech_to_text: SpeechToText | None = None,
) -> FastAPI:
    """`speech_to_text` defaults to Deepgram when DEEPGRAM_API_KEY is set (else the browser transcribes)."""
    settings = settings or get_settings()

    app = FastAPI(
        title="Client Meeting Simulator",
        version="1.0.0",
        description="Voice role-play of client meetings about a project or a partnership, powered by Claude.",
    )
    app.state.settings = settings
    app.state.store = SessionStore(
        ttl_seconds=settings.session_ttl_minutes * 60,
        max_sessions=settings.max_sessions,
    )
    app.state.llm = llm or AnthropicLLM(settings)
    if speech_to_text is None and settings.deepgram_api_key:
        speech_to_text = DeepgramFlux(settings)
    app.state.speech = speech_to_text

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["*"],
    )
    app.include_router(routes.router)
    app.include_router(realtime.router)
    app.include_router(speech.router)

    # In production the built React app is served from the same origin as the API.
    dist = settings.frontend_dist
    if (dist / "index.html").is_file():
        app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")

    return app


app = create_app()
