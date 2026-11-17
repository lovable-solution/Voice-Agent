"""Application settings, read from environment variables and an optional `.env` file."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent

Effort = Literal["low", "medium", "high", "xhigh", "max"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Credentials. When unset, the Anthropic SDK falls back to its own resolution
    # (ANTHROPIC_AUTH_TOKEN, an `ant auth login` profile, ...).
    anthropic_api_key: str | None = None

    # Live conversation. Spoken turns are short, and time to first token is what
    # the user feels, so the meeting runs at low effort by default.
    chat_model: str = "claude-opus-5-5"
    chat_effort: Effort = "low"
    chat_max_tokens: int = Field(default=8192, ge=256)

    # One-off analysis of the material before the meeting starts.
    briefing_model: str = "claude-opus-5-5"
    briefing_effort: Effort = "medium"
    briefing_max_tokens: int = Field(default=16000, ge=1024)

    # Retry a classifier refusal on Anthropic's recommended fallback model
    # (server-side `fallbacks: "default"`).
    enable_refusal_fallbacks: bool = True

    # Speech-to-text for the participant. With a Deepgram key their speech is transcribed by
    # Deepgram Flux, which also decides when they've finished a turn; without one the browser's
    # own speech recognition is used.
    deepgram_api_key: str | None = None
    deepgram_model: str = "flux-general-en"
    deepgram_url: str = "wss://api.deepgram.com/v2/listen"

    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
    session_ttl_minutes: int = Field(default=240, ge=1)
    max_sessions: int = Field(default=100, ge=1)
    max_upload_mb: int = Field(default=10, ge=1)

    # Serve the production build of the React app from FastAPI when it exists.
    frontend_dist: Path = BACKEND_DIR.parent / "frontend" / "dist"


@lru_cache
def get_settings() -> Settings:
    return Settings()
