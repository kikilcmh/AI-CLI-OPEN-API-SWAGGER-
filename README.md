<div align="center">

# AGY AI Gateway

**A self-hosted API gateway that unifies Google Antigravity (agy) and Anthropic Claude Code into a single REST API**

![Node.js](https://img.shields.io/badge/Node.js-24-339933?style=flat-square&logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?style=flat-square&logo=express&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

[Features](#features) · [Architecture](#architecture) · [Quick Start](#quick-start) · [Authentication](#authentication) · [API Reference](#api-reference) · [Dashboard](#dashboard)

</div>

---

## Overview

AGY AI Gateway wraps two powerful AI CLI tools — **Google Antigravity** (`agy`) and **Anthropic Claude Code** (`claude`) — behind a unified HTTP API. Run it on your own server, call it from any application, and manage everything through the built-in web dashboard.

**Why use this?**

- Access Gemini, Claude, and GPT models through a single endpoint
- Stream responses in real time via Server-Sent Events
- Persist and resume conversations across sessions
- Issue separate API keys per app/team without exposing CLI credentials
- Monitor your remaining quota for both backends from one place

---

## Features

| Category | Details |
|---|---|
| **LLM Backends** | Antigravity (Gemini 4, Gemini 3.8 Flash, Claude via Google, GPT-OSS 120B) + Claude Code (Opus 4.8, Sonnet 4.6, Haiku 4.5) |
| **Streaming** | Server-Sent Events (SSE) with real-time token deltas |
| **Sessions** | Persistent conversations, resumable by session ID |
| **Multi-tenancy** | App registration + per-user auth isolation |
| **Image Uploads** | Multipart form uploads with vision support on both backends |
| **Auto-routing** | LLM-driven backend selection (`/route` endpoint) |
| **Dashboard** | Full-featured web UI — chat, sessions, app/user management |
| **API Docs** | Interactive Swagger UI at `/docs` |
| **Quota Monitoring** | Live remaining quota bars for Claude and AGY in the sidebar |

---

## Architecture

```
                        ┌──────────────────────────────┐
                        │      AGY AI Gateway          │
  Browser / Client ───▶ │          :3986               │
                        │                              │
                        │  GET /dashboard ──▶ proxy ──▶│──▶ Dashboard UI (internal)
                        │  GET /docs      ──▶ Swagger  │
                        │  POST /chat     ──────────── │──▶  agy CLI (Gemini, GPT…)
                        │  POST /route    ──────────── │──▶  claude CLI (Anthropic)
                        │  GET  /sessions ──────────── │──▶  local session store
                        │  POST /apps     ──────────── │──▶  apps.json
                        └──────────────────────────────┘
```

A single port serves everything. The dashboard container runs internally and is proxied through the API — no extra ports needed.

---

## Quick Start

### Prerequisites

| Requirement | Notes |
|---|---|
| Docker & Docker Compose | v2+ |
| [`agy`](https://developers.google.com/antigravity) | Installed and authenticated on the host |
| [`claude`](https://github.com/anthropics/claude-code) | Installed and authenticated on the host |

### 1. Clone the repository

```bash
git clone https://github.com/kikilcmh/AI-CLI-OPEN-API-SWAGGER-.git
cd AI-CLI-OPEN-API-SWAGGER-
```

### 2. Create `.env`

```bash
cp .env.example .env
```

```env
PORT=3986

# At least one auth method is required
API_KEYS=your-legacy-api-key        # comma-separated for multiple keys
ADMIN_KEY=your-admin-key            # required for app/user management

# Optional
CORS_ORIGIN=*
AGY_SKIP_PERMISSIONS=1
```

### 3. Update volume paths in `docker-compose.yml`

```yaml
volumes:
  - /home/youruser/.local/bin/agy:/usr/local/bin/agy:ro
  - /usr/bin/claude:/usr/bin/claude:ro
  - /home/youruser/.gemini:/home/app-data/.gemini:rw
  - /home/youruser/.claude:/home/app-data/.claude:rw
  - /home/youruser/workspace:/workspace:rw
```

### 4. Start

```bash
docker compose up -d
```

| URL | Description |
|---|---|
| `http://localhost:3986/dashboard` | Web dashboard |
| `http://localhost:3986/docs` | Swagger API docs |
| `http://localhost:3986/health` | Health check |

---

## Authentication

Three auth modes are supported, evaluated in order on every request:

### Admin Key
Full access — can create/delete apps and users, see all sessions.

```
X-Api-Key: <ADMIN_KEY>
```

### App + User Key
Scoped access — sessions are isolated per app and user.

```
X-Api-Key: <app_api_key>
X-User-Id: <user_id>
```

### Legacy Key
Single-user access via `API_KEYS` env variable. Used by the dashboard.

```
X-Api-Key: <API_KEYS value>
```

> If no auth is configured, the API runs open (no key required).

---

## API Reference

Full interactive documentation is available at `/docs`. Below is a quick reference.

### Chat

Start or continue a conversation.

```
POST /chat
POST /sessions/{session_id}/chat
```

**Request body:**

```json
{
  "prompt": "Explain how transformers work",
  "tool": "agy",
  "model": "gemini-2.5-pro",
  "stream": true
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | ✓ | Your message |
| `tool` | string | ✓ | `agy` or `claude` |
| `model` | string | — | Model ID from `/models`. Uses server default if omitted |
| `stream` | boolean | — | Enable SSE streaming (default `false`) |

---

### Auto-routing

Let the LLM decide which backend to use.

```
POST /route
POST /sessions/{session_id}/route
```

Same request body as `/chat`. Returns an extra SSE event `route` indicating which tool was selected.

---

### Sessions

```http
GET    /sessions                     # List all sessions (paginated)
GET    /sessions/{id}                # Session metadata
GET    /sessions/{id}/messages       # Full conversation history
GET    /sessions/{id}/tool           # Which tool/model this session uses
DELETE /sessions/{id}                # Delete session
```

**Query params for `GET /sessions`:**

| Param | Default | Description |
|---|---|---|
| `limit` | `20` | Max results (up to 200) |
| `offset` | `0` | Pagination offset |
| `q` | — | Full-text search on title and preview |

---

### Models

```http
GET /models?tool=agy      # Antigravity models
GET /models?tool=claude   # Claude Code models
```

**Available models:**

<table>
<tr><th>Backend</th><th>Model</th></tr>
<tr><td rowspan="10"><strong>AGY</strong><br>(Antigravity)</td><td>Gemini 4 Hydrogen (High / XHigh / Medium / Low)</td></tr>
<tr><td>Gemini 3.8 Flash (High / Medium / Low)</td></tr>
<tr><td>Claude Sonnet 4.6 (Thinking)</td></tr>
<tr><td>Claude Opus 4.6 (Thinking)</td></tr>
<tr><td>GPT-OSS 120B (Medium)</td></tr>
<tr><td colspan="1"></td></tr>
<tr><td rowspan="4"><strong>Claude</strong><br>(Anthropic)</td><td>Claude Opus 4.8</td></tr>
<tr><td>Claude Sonnet 4.6</td></tr>
<tr><td>Claude Haiku 4.5</td></tr>
</table>

---

### Apps & Users *(admin only)*

**Apps:**

```http
POST   /apps                   # Create app → returns api_key
GET    /apps                   # List all apps
GET    /apps/{app_id}          # App detail
DELETE /apps/{app_id}          # Delete app and all its users
```

```json
// POST /apps
{ "name": "My Mobile App" }

// Response
{
  "app_id": "uuid",
  "name": "My Mobile App",
  "api_key": "...",
  "created_at": "2026-01-01T00:00:00Z"
}
```

**Users:**

```http
POST   /apps/{app_id}/users              # Create user
GET    /apps/{app_id}/users              # List users
GET    /apps/{app_id}/users/{user_id}    # User detail
DELETE /apps/{app_id}/users/{user_id}    # Delete user
```

```json
// POST /apps/{app_id}/users
{ "name": "Alice", "external_id": "alice_123" }
```

---

### Quota

```http
GET /usage
```

Returns remaining quota from both CLIs:

```json
{
  "claude": {
    "session": { "usedPct": 84, "resetAt": "Nov 25, 9pm (UTC)" },
    "week":    { "usedPct": 63, "resetAt": "Nov 30, 11am (UTC)" }
  },
  "agy": [
    {
      "name": "Gemini Models",
      "buckets": [{ "remainingPct": 68, "resetAt": "2026-12-01T15:01:08Z" }]
    },
    {
      "name": "Claude and GPT models",
      "buckets": [{ "remainingPct": 100, "resetAt": "2026-11-27T17:57:24Z" }]
    }
  ]
}
```

---

## Streaming

All `/chat` and `/route` endpoints stream via Server-Sent Events when `stream: true`.

```bash
curl -N -X POST http://localhost:3986/chat \
  -H "X-Api-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello", "tool": "agy", "stream": true}'
```

**SSE event types:**

| Event | Payload | Description |
|---|---|---|
| `init` | `{ conversation_id }` | Session started |
| `step_update` | `{ text_delta }` or `{ tool_name, state }` | Token delta or tool activity |
| `result` | `{ session_id, … }` | Final result |
| `route` | `{ tool }` | *(auto-route only)* Selected backend |
| `error` | `{ error }` | Error occurred |

---

## Image Uploads

Attach images to any chat endpoint via multipart form:

```bash
curl -X POST http://localhost:3986/chat/upload \
  -H "X-Api-Key: your-key" \
  -F "prompt=What is in this image?" \
  -F "tool=agy" \
  -F "model=gemini-2.5-pro" \
  -F "images=@screenshot.png"
```

Both `agy` and `claude` backends support vision.

---

## Dashboard

Access at `http://localhost:3986/dashboard`

<table>
<tr><th>Section</th><th>Description</th></tr>
<tr><td><strong>Overview</strong></td><td>API status, session count, available models with quick-launch</td></tr>
<tr><td><strong>Sessions</strong></td><td>Browse, search, and resume all past sessions</td></tr>
<tr><td><strong>New Chat</strong></td><td>Pick a backend and model, then start a conversation</td></tr>
<tr><td><strong>Apps</strong></td><td>Create and manage apps; expand to view/add/delete users per app</td></tr>
<tr><td><strong>API Docs</strong></td><td>Opens Swagger UI in a new tab</td></tr>
<tr><td><strong>Quota (sidebar)</strong></td><td>Live remaining quota bars — Claude (weekly + session) and AGY (Gemini, Claude/GPT)</td></tr>
</table>

---

## Project Structure

```
.
├── index.js                 # API server — routes, auth, streaming, session logic
├── Dockerfile               # API container image
├── docker-compose.yml       # Orchestration: API + dashboard
├── package.json
├── .env                     # Local config (not committed)
├── .gitignore
└── dashboard/
    ├── server.js            # Lightweight proxy server (injects API key, serves static)
    ├── Dockerfile
    ├── package.json
    └── public/
        └── index.html       # Single-page dashboard (vanilla JS + Tailwind CDN)
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | — | API port (default `3986`) |
| `API_KEYS` | ✓* | Comma-separated legacy API keys |
| `ADMIN_KEY` | ✓* | Admin key for app/user management |
| `CORS_ORIGIN` | — | CORS allowed origin (default `*`) |
| `AGY_SKIP_PERMISSIONS` | — | Skip agy permission prompts (`1` to enable) |
| `AGY_CWD` | — | Working directory for agy file operations |

*At least one of `API_KEYS` or `ADMIN_KEY` is recommended. Without either, the API runs open.

---

## License

MIT © 2026
