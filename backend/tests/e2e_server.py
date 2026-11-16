"""Run the real app with a scripted stand-in for Claude, for browser end-to-end tests.

    python -m tests.e2e_server --port 8765

Serves the built frontend (frontend/dist) and the API on one origin. Replies stream word
by word like the real model, so the browser exercises the same code paths.
"""

from __future__ import annotations

import argparse
import asyncio
from collections.abc import AsyncGenerator, Sequence

import uvicorn

from app.config import Settings
from app.main import create_app
from app.schemas import Briefing, ClientPersona

OPENING = "Hi Alex, thanks for making the time. Shall we start with the tracking portal?"
LONG_REPLY = (
    "Sure, let me walk you through the whole scope. First, the booking flow has to be rebuilt from scratch. "
    "Second, the live map needs the vessel tracking feed. Third, customers need their customs documents in one place. "
    "Fourth, admins must manage their own staff. And finally, we need a proper hand-over."
)
SHARED_REPLY = (
    "Thanks for sending that over. I've had a quick look. A pilot with three agents sounds sensible, "
    "but who covers support during the pilot?"
)
DEFAULT_REPLY = "That's helpful, thank you. What similar project have you delivered, and how long did it take?"


class ScriptedLLM:
    credentials_configured = True

    async def generate_briefing(self, *, system: str, prompt: str) -> Briefing:
        await asyncio.sleep(0.3)
        return Briefing(
            persona=ClientPersona(
                name="Morgan Reyes",
                role="Head of Digital",
                company="Northwind Freight",
                company_summary="A 120-person freight forwarder in Rotterdam modernizing its customer tools.",
                communication_style="Calm and precise; asks for concrete examples.",
            ),
            meeting_title="Discovery call: customer tracking portal",
            situation="Northwind needs its tracking portal replaced before the spring peak season.",
            project_summary="Rebuild the customer portal: booking, live map, documents.",
            partnership_summary="A white-label version for partner agents with a 60/40 revenue share.",
            key_facts=["Budget is €45,000–€55,000 fixed price", "Four months, starting in January"],
            priorities=["Launch before peak season"],
            concerns=["A 40% revenue share is high"],
            questions_to_ask=["What similar platform have you built?"],
            agenda=["Introductions", "Scope and timeline", "Partnership idea"],
            opening_line=OPENING,
        )

    async def stream_reply(self, *, system: str, messages: Sequence[dict[str, str]]) -> AsyncGenerator[str, None]:
        last = messages[-1]["content"]
        if "<shared_document" in last:
            reply = SHARED_REPLY
        elif "explain" in last.lower():
            reply = LONG_REPLY
        else:
            reply = DEFAULT_REPLY
        words = reply.split(" ")
        for index, word in enumerate(words):
            await asyncio.sleep(0.01)
            yield word if index == len(words) - 1 else word + " "


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    settings = Settings(cors_origins=[f"http://127.0.0.1:{args.port}", f"http://localhost:{args.port}"])
    uvicorn.run(create_app(settings=settings, llm=ScriptedLLM()), host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
