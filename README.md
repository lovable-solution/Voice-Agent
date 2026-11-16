# Client Meeting Simulator

A voice agent for rehearsing client meetings. Give it a job posting, your partnership ideas, or both. Claude studies the material, becomes the client, and holds a spoken meeting with you, with live subtitles for both sides.

- **Backend:** FastAPI (Python): Claude integration, sessions, a WebSocket for the live conversation.
- **Frontend:** React + TypeScript (Vite): the browser's speech recognition and speech synthesis, live subtitles, transcript.

## What it does

| Requirement | How it's met |
| --- | --- |
| Simulate a meeting with a client | Claude plays a consistent client persona (name, role, company, temperament, goals, concerns) and runs the meeting: it opens, asks questions, probes vague answers, and closes with next steps. |
| Subject: a project and a potential partnership | Provide a job posting, partnership ideas, or both. With both, it's one client who posted the project and also weighs your partnership proposal. |
| Learn a job posting, then talk as the client | Before the meeting, a briefing step turns the posting into what the client knows, cares about, worries about, and plans to ask. The full posting stays in the client's context word for word. |
| Learn partnership ideas, then discuss them | The client reads your ideas before the meeting and weighs them from its company's side. You can also share new ideas mid-meeting (Share tab); the client reads them and reacts. |
| FastAPI backend, React frontend | `backend/` and `frontend/`. |
| Subtitles during the conversation | Live captions for both speakers: the client's words light up as they're spoken, and yours appear as you talk. A full transcript sits alongside. |

Also included:
- Upload a posting or proposal as PDF, Word, HTML, Markdown, or text.
- Choose the client's temperament: friendly, neutral, skeptical, or demanding.
- Interrupt the client at any time.
- Type instead of speaking whenever you like.
- Pick the client's voice and speaking speed.
- Download the transcript as Markdown when the meeting ends.

## Quick start

**You need:** Python 3.10+, Node.js 20.19+, an [Anthropic API key](https://platform.claude.com/settings/keys), and Chrome, Edge, or Safari to speak (see [Browser support](#browser-support)).

```bash
# 1. Backend
cd backend
cp .env.example .env            # then set ANTHROPIC_API_KEY in .env
uv sync                         # or: python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/uvicorn app.main:app --reload --port 8000

# 2. Frontend (second terminal)
cd frontend
npm install
npm run dev                     # open http://localhost:5173
```

After the one-time installs, `./scripts/dev.sh` starts both servers together.

**Single-server mode:** run `npm run build` in `frontend/` and start the backend as above. FastAPI then serves the app at http://localhost:8000.

## Using it

1. **Add the material.** Paste a job posting and/or partnership ideas, or upload files. **Load an example** fills in a sample freight-portal project and partnership. Optionally add your name and background (the client will know them), the client's temperament, and the client's name.
2. **Prepare the meeting.** Claude reads everything and builds the client. The briefing page shows who you'll meet and what they know, care about, and worry about. The questions they plan to ask stay hidden until you click **Reveal**.
3. **Check your audio.** Pick a voice, click **Test voice**, then **Join the meeting**. Allow microphone access when the browser asks.
4. **Talk.** The client speaks first. When they finish, just answer; pausing for about 1.2 seconds ends your turn.

   | Key | Action |
   | --- | --- |
   | <kbd>Esc</kbd> | Interrupt the client |
   | <kbd>M</kbd> | Mute or unmute your mic |
   | <kbd>C</kbd> | Show or hide subtitles |

   The side panel has the **Transcript** (with a box for typing replies), **Share** (send a document mid-meeting), and **Brief** (your notes on the client).
5. **Leave** to see the stats and full transcript, and download it.

Settings (gear button):
- **Voice:** the voice, its speed, and captions-only mode (no audio).
- **Subtitles:** caption size.
- **Mic:** the pause that ends your turn, and **I'm wearing headphones**, which lets you interrupt just by speaking.

## How it works

```
 Browser (React)                                FastAPI                         Claude
 ┌──────────────────────────────┐               ┌───────────────────────┐
 │ SpeechRecognition ── words ──┼── WebSocket ─►│ MeetingConnection     │── stream ──► claude-opus-5-5
 │ speechSynthesis ◄─ sentences │◄── deltas ────│  session + history    │◄─ text ─────
 │ subtitles follow the voice   │               │ POST /api/sessions    │── structured output (briefing)
 └──────────────────────────────┘               └───────────────────────┘
```

**Learning the material.** `POST /api/sessions` makes one structured-output call that turns the material into a `Briefing`: the persona, the situation, key facts, priorities, concerns, an agenda, questions, and an opening line. The meeting's system prompt then combines the raw material (verbatim), the briefing, and rules for speaking naturally and staying in character. That prompt is fixed for the whole session. Documents shared mid-meeting are added to the conversation as your turn, inside `<shared_document>` tags, rather than by editing the prompt. This keeps the request prefix identical from turn to turn, so prompt caching works.

**Voice.**
- Replies stream from Claude token by token. The browser splits them into sentences and starts speaking as soon as the first sentence is complete.
- Subtitles highlight each word as it's spoken. Most voices report word timing; for the ones that don't (many online voices), the timing is estimated from a speaking pace that recalibrates after every sentence.
- Your own speech appears live as you talk, from the recognizer's interim results.

**Turn-taking and interruptions.**
- By default the mic pauses while the client speaks, so the client can't hear itself through your speakers.
- When you interrupt, the browser stops the voice and tells the server exactly how much was heard. The stored reply is cut to those words and ends with `—`, so Claude's view of the conversation matches what you actually heard.
- A new turn from you (spoken, typed, or a shared document) always cancels a reply that's still generating.

**Model settings.**
- Every turn runs on `claude-opus-5-5`: at low effort during the meeting, where response time matters, and at medium effort for the one-off briefing.
- **Refusal fallbacks are on** (server-side `fallbacks: "default"`). If a safety classifier declines a request, the API retries it on Anthropic's recommended fallback model instead of failing. Turn this off with `ENABLE_REFUSAL_FALLBACKS=false`.
- Errors are shown to you, never spoken in the client's voice. A turn that fails before saying anything is dropped from the history.

## Configuration

Set these in `backend/.env`; see `backend/.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none | Your API key. If unset, the SDK's other credential sources are used (e.g. `ANTHROPIC_AUTH_TOKEN`). |
| `CHAT_MODEL` / `CHAT_EFFORT` | `claude-opus-5-5` / `low` | Model and effort for live turns. Lower effort means faster replies. |
| `CHAT_MAX_TOKENS` | `8192` | Upper bound per turn (thinking plus reply). |
| `BRIEFING_MODEL` / `BRIEFING_EFFORT` | `claude-opus-5-5` / `medium` | Model and effort for analyzing the material. |
| `ENABLE_REFUSAL_FALLBACKS` | `true` | Retry classifier refusals on a fallback model. |
| `CORS_ORIGINS` | `["http://localhost:5173","http://127.0.0.1:5173"]` | Browser origins allowed to use the API and the WebSocket. |
| `SESSION_TTL_MINUTES` | `240` | Idle meetings are discarded after this long. |
| `MAX_UPLOAD_MB` | `10` | Maximum upload size for document extraction. |

The frontend dev server proxies `/api` to `http://127.0.0.1:8000`. Set `BACKEND_URL` to point it elsewhere.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Status, configured models, and whether credentials are present. |
| `POST` | `/api/sessions` | Body: `{materials: [{kind, title?, content}], user_name?, user_background?, client_name?, personality}`. Returns the session with its briefing. |
| `GET` | `/api/sessions/{id}` | Session, materials, and full message history. |
| `DELETE` | `/api/sessions/{id}` | End and discard a session. |
| `POST` | `/api/documents/extract` | Multipart `file` → `{filename, text, characters}`. |
| `WS` | `/api/sessions/{id}/ws` | The live meeting: `start`, `user_message`, `interrupt`, `share_material`, and `ping` in; `ready`, `message_saved`, `material_added`, `assistant_start`, `assistant_delta`, `assistant_end`, and `error` out. The full protocol is documented in `backend/app/realtime.py`. |

Interactive API docs are at http://localhost:8000/docs while the backend runs.

## Browser support

- **Speaking (speech recognition):** Chrome and Edge on desktop, and Safari.
  - Chrome sends the audio to Google's speech service, so it needs an internet connection.
  - Firefox has no speech recognition. Some Chromium builds don't work either, including Brave and some Linux distribution packages of Chromium; they fail with a "network" error.
  - In those browsers you can still type your replies, and the client still speaks.
- **The client's voice (speech synthesis):** all modern browsers. Quality depends on the voices your system provides.
  - On Linux, Chrome lists Google's online voices next to the local espeak-ng voices, which sound robotic. Pick a "Google" voice under **Client's voice**.
  - If playback fails, the meeting carries on with subtitles only.
- **Microphone:** the page must be served from `localhost` or over HTTPS.

## Testing

```bash
cd backend && .venv/bin/python -m pytest       # 33 tests
cd frontend && npm test                        # 25 tests
cd frontend && npm run build && npm run test:e2e   # 3 browser tests
```

- **Backend:** REST endpoints, the WebSocket protocol, interruptions, disconnects, errors and refusals, document extraction, and prompt construction.
- **Frontend unit tests:** the turn-taking controller, sentence chunking, cleaning text for speech, and caption timing.
- **End-to-end:** runs the real app in Google Chrome, with simulated speech and a scripted stand-in for Claude. It covers setup, the briefing, spoken turns with subtitles, an interruption (checked against the server's stored history), mid-meeting sharing, typed replies, headphones mode, muting, and the transcript download. It needs Google Chrome installed. To use Playwright's bundled Chromium instead, run `npx playwright install chromium` and set `E2E_CHANNEL=chromium`.

None of the tests call the real Anthropic API.

## Project structure

```
backend/
  app/
    main.py         app factory; also serves frontend/dist when it exists
    config.py       settings from env / .env
    schemas.py      API + WebSocket models; the Briefing schema used for structured output
    prompts.py      briefing prompt, in-character meeting prompt, history helpers
    llm.py          Claude calls: briefing (structured output) and streamed replies
    realtime.py     the live meeting WebSocket: streaming, interruptions, shared documents
    routes.py       REST endpoints
    documents.py    PDF / DOCX / HTML / text extraction
    store.py        in-memory sessions
  tests/            pytest suite + e2e_server.py (the app with a scripted Claude, for browser tests)
frontend/
  src/
    meeting/        controller.ts (turn-taking state machine), transport.ts (WebSocket), useMeeting.ts
    speech/         recognizer, synthesizer (sentence queue + word timing), voices, mic level
    lib/            sentence chunking, speech text cleanup, caption timing, transcript export
    components/     setup, briefing, meeting room, subtitles, transcript, share, settings, end screen
  e2e/              Playwright tests and the simulated speech APIs
scripts/dev.sh      start backend + frontend together
```

## Notes and limitations

- Sessions live in server memory. Restarting the backend ends any open meeting, though the transcript stays on screen. To run several workers, replace `SessionStore` with a shared store.
- **Privacy:** your material and the conversation are sent to the Anthropic API. In Chrome, your speech audio is transcribed by Google's speech service.
- **Cost:** every turn is a Claude request. The fixed system prompt and the growing conversation are cached between turns, so each turn mainly pays for new tokens.
