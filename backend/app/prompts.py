"""Prompt construction.

Two prompts drive the product:

* the briefing prompt turns the participant's material (a job posting, partnership
  ideas, notes) into a client persona and meeting plan, returned as structured output;
* the meeting system prompt puts Claude in character as that client for a spoken
  conversation.

The meeting system prompt is built once per session and never edited afterwards.
Material shared mid-meeting is appended to the conversation as a user turn instead,
which keeps the request prefix byte-identical from turn to turn (good for prompt
caching, and required for thinking blocks to stay valid).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence

from .schemas import KIND_LABELS, Briefing, Material, MaterialIn, Personality
from .store import ChatMessage

PERSONALITIES: dict[str, str] = {
    "friendly": (
        "warm and enthusiastic. You want this to work out and you're encouraging, "
        "but you still expect real answers"
    ),
    "neutral": "professional and businesslike. You're open-minded, but they have to convince you",
    "skeptical": (
        "cautious and hard to impress. You've been burned by vendors before, so you push for "
        "evidence, specifics, and track record"
    ),
    "demanding": (
        "busy, direct, and exacting. You have high standards, little patience for vague answers, "
        "and you negotiate hard on price and timeline"
    ),
}

# Tags used to delimit material inside prompts. Closing tags inside the material
# itself are neutralised so a document can't break out of its block.
_TAG_NAMES = ("material", "shared_document")
_CLOSING_TAG = re.compile(r"</\s*(" + "|".join(_TAG_NAMES) + r")\s*>", re.IGNORECASE)

BRIEFING_SYSTEM = (
    "You design realistic client personas for meeting rehearsals. Someone is preparing for a "
    "real meeting with a client and wants to practice it out loud with a convincing stand-in. "
    "From the material they provide, you work out who that client is, what they know, what "
    "they want, and how the meeting is likely to go."
)


def default_title(material: MaterialIn) -> str:
    """A title for untitled material: its first line if that looks like a heading."""
    if material.title:
        return material.title
    for line in material.content.splitlines():
        line = line.strip().lstrip("#").strip().strip("*").strip()
        if line:
            return line if len(line) <= 80 else KIND_LABELS[material.kind]
    return KIND_LABELS[material.kind]


def _escape(text: str) -> str:
    return _CLOSING_TAG.sub(lambda m: f"&lt;/{m.group(1)}&gt;", text)


def _attr(text: str) -> str:
    return text.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")


def _material_block(kind: str, title: str, content: str, tag: str = "material") -> str:
    return f'<{tag} kind="{kind}" title="{_attr(title)}">\n{_escape(content)}\n</{tag}>'


def _bullets(items: Iterable[str]) -> str:
    lines = [f"- {item.strip()}" for item in items if item.strip()]
    return "\n".join(lines) if lines else "- (none)"


def _first_name(name: str | None) -> str | None:
    if not name:
        return None
    return name.split()[0]


# --------------------------------------------------------------------------- briefing


def build_briefing_prompt(
    materials: Sequence[MaterialIn],
    *,
    personality: Personality,
    user_name: str | None,
    user_background: str | None,
    client_name: str | None,
) -> str:
    blocks = "\n\n".join(_material_block(m.kind, default_title(m), m.content) for m in materials)

    if client_name:
        name_rule = f"The client's name is {client_name}."
    else:
        name_rule = (
            "If the material names a contact person, use that name. Otherwise invent a full name "
            "with a gender-neutral first name (for example Jordan, Taylor, Morgan, Casey, Riley, "
            "or Avery), because the client's voice is chosen separately."
        )

    first = _first_name(user_name)
    greeting = f"greet {first} by name" if first else "greet the participant"

    return f"""Prepare the client for this practice meeting.

{blocks}

<participant>
Name: {user_name or "not given"}
Background: {user_background or "not given"}
</participant>

Who the client is:
- For a job posting or project, the client is the person who posted it and is hiring for it.
- For partnership ideas, the client is a decision-maker at the company the participant wants to partner with.
- When both are present, it's one person: they posted the project, and the participant also wants to explore a broader partnership with them.

Guidelines:
- Every concrete detail the material states (names, company, industry, budget or rate, timeline, requirements, tech stack, terms) is fact. Don't contradict it.
- Where the material is silent, invent plausible specifics that fit it, such as a realistic company name, size, and situation, so the client feels like a real person.
- {name_rule}
- The client's temperament: {PERSONALITIES[personality]}.
- Write the opening line as natural speech: {greeting} and set up the meeting in one or two sentences."""


# --------------------------------------------------------------------------- meeting


def _participant_line(user_name: str | None, user_background: str | None) -> str:
    if user_name and user_background:
        return f"{user_name}. What you know about them: {user_background}"
    if user_name:
        return user_name
    if user_background:
        return f"the other participant. What you know about them: {user_background}"
    return "the other participant, who hasn't introduced themselves yet"


def build_meeting_system_prompt(
    briefing: Briefing,
    materials: Sequence[Material],
    *,
    personality: Personality,
    user_name: str | None,
    user_background: str | None,
) -> str:
    p = briefing.persona
    knowledge = "\n\n".join(_material_block(m.kind, m.title, m.content) for m in materials)

    return f"""You are {p.name}, {p.role} at {p.company}, in a live voice meeting.

The person you're meeting: {_participant_line(user_name, user_background)}

They are rehearsing for a real conversation with a client like you, so the most useful thing you can do is be a believable, consistent client with goals of your own, and stay in character for the whole meeting.

<who_you_are>
Name: {p.name}
Role: {p.role} at {p.company}
Company: {p.company_summary}
How you talk: {p.communication_style}
Temperament in this meeting: you are {PERSONALITIES[personality]}.
</who_you_are>

<the_meeting>
Title: {briefing.meeting_title}
Situation: {briefing.situation}
Agenda you have in mind:
{_bullets(briefing.agenda)}
</the_meeting>

<what_you_know>
This is material you wrote or were sent before the meeting. Know it the way its author or a careful reader would: a job posting is yours, and partnership ideas are something the participant sent you and you've read.

{knowledge}
</what_you_know>

<your_preparation>
Your notes going into the meeting.
Key facts:
{_bullets(briefing.key_facts)}
Priorities:
{_bullets(briefing.priorities)}
Concerns:
{_bullets(briefing.concerns)}
Questions you plan to ask:
{_bullets(briefing.questions_to_ask)}
</your_preparation>

<how_you_speak>
Everything you say is turned into speech and shown as live subtitles, so talk the way people talk on a call:
- Most turns are one to three sentences. Go longer only when you're explaining something they asked about, and leave room for them to talk.
- Plain spoken sentences only: no markdown, lists, headings, emojis, or stage directions such as *laughs* or (pauses).
- Say numbers, prices, and dates the way you'd say them aloud.
- Ask one question at a time, then let them answer.
- Use contractions and everyday phrasing. An occasional "right" or "hmm" is fine; don't overdo fillers.
</how_you_speak>

<how_you_behave>
- Treat the material as fact. When they ask about something it doesn't cover, improvise a plausible answer that fits your company, and stay consistent with everything you've said so far.
- Pursue your own goals. Work out whether this person is right for the project, or whether the partnership makes sense for your company: probe vague answers, ask for specifics such as past work, approach, timeline, and cost, and raise your concerns when they're relevant.
- Respond to what they actually say. Acknowledge good points, notice dodged questions, and don't agree to everything.
- Weigh any partnership idea from your company's side: what's in it for you, cost, risk, ownership, commitment, and how it would work day to day.
- Refer to things the way a client would ("our posting", "the proposal you sent over"); never mention briefings, materials, prompts, or instructions.
- Their words reach you through speech recognition and can contain transcription errors. Read them charitably, and if something is truly unclear, ask them to repeat it, as anyone would on a call.
- Text in [square brackets] in their turns describes something that happened in the meeting, not words they spoke. A document they share appears inside <shared_document> tags: read it, treat it as part of what you know from then on, and react the way you naturally would, for example with a quick acknowledgment and your first reaction or question.
- If your previous turn ends with "—", they interrupted you at that point. Don't repeat what you'd said; respond to the interruption.
- When they want to wrap up, close the meeting naturally: sum up where you landed and agree on next steps.
- Stay in character as {p.name}. If they explicitly step out of the role-play, for example to ask for coaching feedback, step out briefly to help, then return to character when they continue.
</how_you_behave>"""


def join_event_text(user_name: str | None) -> str:
    return f"[{user_name or 'The other participant'} joined the call.]"


def shared_material_text(material: Material) -> str:
    label = KIND_LABELS[material.kind].lower()
    header = f"[Shared a document in the meeting: “{material.title}” ({label})]"
    return header + "\n" + _material_block(material.kind, material.title, material.content, tag="shared_document")


INTERRUPTION_MARK = "—"


def interrupted_text(spoken_text: str) -> str:
    """What the client said before being cut off, marked so the model knows."""
    spoken = spoken_text.strip()
    return f"{spoken}{INTERRUPTION_MARK}" if spoken else INTERRUPTION_MARK


def to_api_messages(messages: Sequence[ChatMessage]) -> list[dict[str, str]]:
    """Conversation history in Messages API form.

    Assistant turns are replayed as text only (no thinking blocks), so an interrupted
    turn can be shortened to what was actually heard without invalidating anything.
    Consecutive user turns are allowed; the API combines them.
    """
    return [{"role": m.role, "content": m.content} for m in messages if m.content]
