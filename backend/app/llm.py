"""Claude access: one structured call to build the briefing, one streamed call per meeting turn."""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator, Sequence
from typing import Any, Protocol

import anthropic
from anthropic import AsyncAnthropic

from .config import Settings
from .schemas import Briefing

logger = logging.getLogger(__name__)

# Server-side refusal fallback: if a safety classifier declines a request, the API
# re-runs it on Anthropic's recommended fallback model inside the same call.
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class LLMError(Exception):
    """A failure talking to Claude, with a message that is safe to show the user."""

    def __init__(self, message: str, *, status_code: int = 502, retryable: bool = False) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.retryable = retryable


class LLMRefusalError(LLMError):
    def __init__(self, message: str) -> None:
        super().__init__(message, status_code=422)


class LLM(Protocol):
    async def generate_briefing(self, *, system: str, prompt: str) -> Briefing: ...

    def stream_reply(self, *, system: str, messages: Sequence[dict[str, str]]) -> AsyncGenerator[str, None]: ...


def translate_error(exc: Exception) -> LLMError:
    """Map SDK exceptions (most specific first) to user-facing errors."""
    if isinstance(exc, LLMError):
        return exc
    if isinstance(exc, anthropic.AuthenticationError):
        return LLMError("Anthropic rejected the API key. Check ANTHROPIC_API_KEY in backend/.env.", status_code=503)
    if isinstance(exc, anthropic.PermissionDeniedError):
        return LLMError("This API key doesn't have access to the configured Claude model.", status_code=503)
    if isinstance(exc, anthropic.NotFoundError):
        return LLMError("The configured Claude model wasn't found. Check CHAT_MODEL and BRIEFING_MODEL.", status_code=503)
    if isinstance(exc, anthropic.RateLimitError):
        return LLMError("The Anthropic API is rate limiting requests. Wait a moment and try again.", status_code=429, retryable=True)
    if isinstance(exc, anthropic.BadRequestError):
        return LLMError(f"The Anthropic API rejected the request: {exc.message}", status_code=502)
    if isinstance(exc, anthropic.APIStatusError):
        if exc.status_code >= 500:
            return LLMError(
                f"The Anthropic API is having trouble (HTTP {exc.status_code}). Try again shortly.",
                status_code=503,
                retryable=True,
            )
        return LLMError(f"Anthropic API error (HTTP {exc.status_code}): {exc.message}", status_code=502)
    if isinstance(exc, anthropic.APIConnectionError):
        return LLMError("Couldn't reach the Anthropic API. Check your network connection.", status_code=503, retryable=True)
    logger.exception("Unexpected error calling Claude", exc_info=exc)
    return LLMError("Something went wrong while talking to Claude.", status_code=500)


class AnthropicLLM:
    def __init__(self, settings: Settings, client: AsyncAnthropic | None = None) -> None:
        self.settings = settings
        if client is None:
            # Without an explicit key the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
            # or an `ant auth login` profile on its own.
            client = AsyncAnthropic(api_key=settings.anthropic_api_key) if settings.anthropic_api_key else AsyncAnthropic()
        self.client = client

    @property
    def credentials_configured(self) -> bool:
        return any(getattr(self.client, attr, None) for attr in ("api_key", "auth_token", "credentials"))

    def _check_credentials(self) -> None:
        if not self.credentials_configured:
            raise LLMError(
                "No Anthropic API key is configured. Add ANTHROPIC_API_KEY to backend/.env "
                "(see backend/.env.example) and restart the server.",
                status_code=503,
            )

    def _fallback_kwargs(self) -> dict[str, Any]:
        if not self.settings.enable_refusal_fallbacks:
            return {}
        return {"betas": [FALLBACK_BETA], "fallbacks": "default"}

    async def generate_briefing(self, *, system: str, prompt: str) -> Briefing:
        self._check_credentials()
        try:
            response = await self.client.with_options(timeout=180.0).beta.messages.parse(
                model=self.settings.briefing_model,
                max_tokens=self.settings.briefing_max_tokens,
                system=system,
                messages=[{"role": "user", "content": prompt}],
                output_format=Briefing,
                output_config={"effort": self.settings.briefing_effort},
                **self._fallback_kwargs(),
            )
        except Exception as exc:
            raise translate_error(exc) from exc

        if response.stop_reason == "refusal":
            raise LLMRefusalError(
                "Claude declined to prepare a client from this material. Try rephrasing it or removing sensitive content."
            )
        if response.stop_reason == "max_tokens" or response.parsed_output is None:
            raise LLMError("The client briefing came back incomplete. Please try again.", retryable=True)
        return response.parsed_output

    async def stream_reply(self, *, system: str, messages: Sequence[dict[str, str]]) -> AsyncGenerator[str, None]:
        """Yield the client's reply as text deltas.

        Cancelling the consumer closes the stream, which stops generation server-side.
        """
        self._check_credentials()
        try:
            async with self.client.beta.messages.stream(
                model=self.settings.chat_model,
                max_tokens=self.settings.chat_max_tokens,
                system=system,
                messages=list(messages),  # type: ignore[arg-type]
                output_config={"effort": self.settings.chat_effort},
                # Cache the conversation prefix; each turn re-reads it from cache.
                cache_control={"type": "ephemeral"},
                **self._fallback_kwargs(),
            ) as stream:
                async for text in stream.text_stream:
                    yield text
                final = await stream.get_final_message()
        except Exception as exc:
            raise translate_error(exc) from exc

        if final.stop_reason == "refusal":
            raise LLMRefusalError("Claude declined to continue this part of the conversation.")
        if final.stop_reason == "max_tokens":
            logger.warning("Reply hit max_tokens (%s); it was cut short.", self.settings.chat_max_tokens)
        usage = final.usage
        logger.debug(
            "turn usage: input=%s cache_read=%s cache_write=%s output=%s",
            usage.input_tokens,
            usage.cache_read_input_tokens,
            usage.cache_creation_input_tokens,
            usage.output_tokens,
        )
