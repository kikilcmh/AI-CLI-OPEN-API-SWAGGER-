# AGY AI Gateway

A self-hosted HTTP API gateway that wraps **Google Antigravity CLI (agy)** and **Anthropic Claude Code CLI** into a unified REST API — with a built-in web dashboard, multi-app/user management, streaming support, and quota monitoring.

---

## Features

- **Dual LLM backends** — Antigravity (Gemini 4, Gemini 3.8 Flash, Claude via Google, GPT) and Claude Code (Claude Opus, Sonnet, Haiku)
- **Streaming responses** — Server-Sent Events (SSE) for real-time token output
- **Session management** — persistent conversation sessions across requests
- **Multi-app / multi-user auth** — register apps, create users, isolate sessions per app/user
- **Image uploads** — attach images to any chat request (vision support)
- **Auto-routing** — let the LLM decide which tool (agy vs claude) to use
- **Web dashboard** — manage sessions, apps, users, and chat directly from the browser
- **Swagger UI** — interactive API docs at `/docs`
- **Quota monitoring** — real-time remaining quota bars for both Claude and AGY

---

## Architecture

```
Browser
  │
  ▼
┌─────────────────────────────────────────┐
│          AGY API  :3986                 │
│                                         │
│  /dashboard  → proxy → Dashboard UI    │
│  /docs       → Swagger UI              │
│  /api/*      → self-proxy (key inject) │
│                                         │
│  Auth: Admin key / App key / Legacy key │
└──────────┬─────────────────────────────┘
           │
     ┌─────┴──────┐
     ▼            ▼
  agy CLI     claude CLI
 (Gemini,    (Anthropic
  GPT, ...)    Claude)
```

Everything runs on a **single port (3986)**. The dashboard container is internal-only, proxied through the API.

---

## Quick Start

### Prerequisites

- Docker & Docker Compose
- [`agy`](https://developers.google.com/antigravity) binary installed on the host
- [`claude`](https://github.com/anthropics/claude-code) CLI installed on the host
- Authenticated sessions for both CLIs on the host machine

### 1. Clone & configure

```bash
git clone <this-repo>
cd 986-ai_API
cp .env.example .env   # then edit .env
```

### 2. Configure `.env`

```env
PORT=3986

# Auth — at least one of these is required
API_KEYS=your-legacy-key-here          # comma-separated for multiple
ADMIN_KEY=your-admin-key-here          # required for app/user management

# Optional
CORS_ORIGIN=*
AGY_SKIP_PERMISSIONS=1
AGY_CWD=/home/youruser
```

### 3. Configure `docker-compose.yml`

Update volume paths to match your host:

```yaml
volumes:
  - /home/youruser/.local/bin/agy:/usr/local/bin/agy:ro
  - /usr/bin/claude:/usr/bin/claude:ro
  - /home/youruser/.gemini:/home/app-data/.gemini:rw
  - /home/youruser/.claude:/home/app-data/.claude:rw
  - /home/youruser/workspace:/workspace:rw
```

### 4. Run

```bash
docker compose up -d
```

- Dashboard → `http://localhost:3986/dashboard`
- API Docs  → `http://localhost:3986/docs`

---

## Authentication

Three modes, checked in order:

| Mode | Header | Use case |
|---|---|---|
| **Admin** | `X-Api-Key: <ADMIN_KEY>` | Full access — manage apps & users |
| **App + User** | `X-Api-Key: <app_key>` + `X-User-Id: <user_id>` | Multi-user integration |
| **Legacy** | `X-Api-Key: <API_KEYS value>` | Single-user / direct dashboard access |

If no auth is configured, the API runs open (no key required).

---

## API Reference

### Chat

```http
POST /chat
POST /sessions/{id}/chat
```

**Body:**
```json
{
  "prompt": "Explain quantum computing",
  "tool": "agy",
  "model": "gemini-2.5-pro",
  "stream": true
}
```

**Tools:** `agy` (Antigravity) or `claude` (Claude Code)

### Auto-routing

```http
POST /route
POST /sessions/{id}/route
```

Same as `/chat` but the LLM decides which backend to use.

### Sessions

```http
GET  /sessions                    # list sessions
GET  /sessions/{id}               # session detail
GET  /sessions/{id}/messages      # conversation history
GET  /sessions/{id}/tool          # which tool/model this session uses
DELETE /sessions/{id}             # delete session
```

### Models

```http
GET /models?tool=agy              # list Antigravity models
GET /models?tool=claude           # list Claude Code models
```

**Available models (AGY):** Gemini 4 Hydrogen (High/XHigh/Medium/Low), Gemini 3.8 Flash (High/Medium/Low), Claude Sonnet 4.6 (Thinking), Claude Opus 4.6 (Thinking), GPT-OSS 120B

**Available models (Claude):** Claude Opus 4.8, Claude Sonnet 4.6, Claude Haiku 4.5

### Apps & Users *(admin only)*

```http
POST   /apps                              # create app
GET    /apps                              # list apps
DELETE /apps/{app_id}                     # delete app

POST   /apps/{app_id}/users              # create user
GET    /apps/{app_id}/users              # list users
DELETE /apps/{app_id}/users/{user_id}    # delete user
```

**Create app:**
```json
{ "name": "My Mobile App" }
```
Response includes `api_key` to use in `X-Api-Key` header.

**Create user:**
```json
{ "name": "John Doe", "external_id": "user_123" }
```

### Quota

```http
GET /usage
```

Returns remaining quota for both Claude and AGY:

```json
{
  "claude": {
    "session": { "usedPct": 84, "resetAt": "Nov 25, 9pm (UTC)" },
    "week":    { "usedPct": 63, "resetAt": "Nov 30, 11am (UTC)" }
  },
  "agy": [
    { "name": "Gemini Models",       "buckets": [{ "remainingPct": 68, "resetAt": "..." }] },
    { "name": "Claude and GPT models","buckets": [{ "remainingPct": 100,"resetAt": "..." }] }
  ]
}
```

### Health

```http
GET /health
```

---

## Dashboard

Access at `http://localhost:3986/dashboard`

| Section | Description |
|---|---|
| **Overview** | API status, session count, available models |
| **Sessions** | Browse, search, and resume past sessions |
| **New Chat** | Start a conversation — pick tool (AGY/Claude) and model |
| **Apps** | Manage registered apps and their users |
| **API Docs** | Opens Swagger UI in a new tab |
| **Quota (sidebar)** | Live remaining quota bars for Claude and AGY |

---

## Image Uploads

Send images via multipart form to any chat endpoint:

```bash
curl -X POST http://localhost:3986/chat/upload \
  -H "X-Api-Key: your-key" \
  -F "prompt=What's in this image?" \
  -F "tool=agy" \
  -F "images=@screenshot.png"
```

---

## Streaming

All `/chat`, `/route`, and session endpoints support SSE streaming when `stream: true`. Events:

| Event | Description |
|---|---|
| `init` | Session started, includes `conversation_id` |
| `step_update` | Token delta (`text_delta`) or tool activity |
| `result` | Final result with `session_id` |
| `route` | (auto-route only) which tool was selected |
| `error` | Error occurred |

```bash
curl -N -X POST http://localhost:3986/chat \
  -H "X-Api-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Hello","tool":"agy","stream":true}'
```

---

## Project Structure

```
986-ai_API/
├── index.js              # Main API server (Express)
├── Dockerfile            # API container
├── docker-compose.yml    # Orchestration (api + dashboard)
├── .env                  # Environment config (not committed)
└── dashboard/
    ├── server.js         # Dashboard proxy server
    ├── Dockerfile
    └── public/
        └── index.html    # Single-page dashboard UI
```

---

## License

MIT
