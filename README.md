<div align="center">

# AGY AI Gateway

**A self-hosted API gateway that unifies Google Antigravity (agy) and Anthropic Claude Code into a single REST API**

![Node.js](https://img.shields.io/badge/Node.js-24-339933?style=flat-square&logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?style=flat-square&logo=express&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

[Features](#features) · [Architecture](#architecture) · [Installation](#installation-guide) · [Quick Start](#quick-start) · [Authentication](#authentication) · [API Reference](#api-reference) · [Dashboard](#dashboard)

</div>

---

## Overview

AGY AI Gateway wraps two powerful AI CLI tools — **Google Antigravity** (`agy`) and **Anthropic Claude Code** (`claude`) — behind a unified HTTP API. Run it on your own server, call it from any application, and manage everything through the built-in web dashboard.

**Why use this?**

- Access Gemini, Claude, and GPT models through a single endpoint
- Stream responses in real time via Server-Sent Events
- Persist and resume conversations automatically per app
- Issue separate API keys per user without exposing CLI credentials
- Monitor remaining quota for both backends from one place

---

## Features

| Category | Details |
|---|---|
| **LLM Backends** | Antigravity (Gemini 2.5 Pro/Flash, Gemini 2.0 Flash, Claude/GPT via Google) + Claude Code (Opus 4.8, Sonnet 4.6, Haiku 4.5) |
| **Streaming** | Server-Sent Events (SSE) with real-time token deltas |
| **Sessions** | Persistent conversations per app — auto-resumed on next chat |
| **Multi-tenancy** | Per-user API keys + app scoping via `X-App-Id` |
| **Image Uploads** | Multipart form uploads with vision support on both backends |
| **Auto-routing** | LLM-driven backend selection (`/route` endpoint) |
| **Dashboard** | Full-featured web UI — chat, sessions, app/user management |
| **API Docs** | Interactive Swagger UI at `/docs` |
| **Quota Monitoring** | Live remaining quota for Claude and AGY via `/usage` |

---

## Architecture

```
                        ┌──────────────────────────────┐
                        │      AGY AI Gateway          │
  Browser / Client ───▶ │          :3986               │
                        │                              │
                        │  GET /dashboard ──▶ proxy ──▶│──▶ Dashboard UI (port 3000)
                        │  GET /docs      ──▶ Swagger  │
                        │  POST /chat     ──────────── │──▶  agy CLI  (Gemini, GPT…)
                        │  POST /route    ──────────── │──▶  claude CLI (Anthropic)
                        │  POST /apps     ──────────── │──▶  apps.json
                        │  POST /users    ──────────── │──▶  users.json
                        └──────────────────────────────┘
```

A single port serves everything. The dashboard container runs on port 3000 internally and is proxied — no extra ports exposed.

---

## Installation Guide

### Step 1 — Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
docker compose version
```

### Step 2 — Install Claude Code CLI

```bash
# Requires Node.js 18+
npm install -g @anthropic-ai/claude-code

# Authenticate (opens browser login)
claude login
claude --version
```

### Step 3 — Install Google Antigravity CLI (agy)

```bash
# Download binary
curl -L https://dl.google.com/antigravity/agy-linux-amd64 -o ~/.local/bin/agy
chmod +x ~/.local/bin/agy

# Authenticate
agy login
agy --version
```

### Step 4 — Verify both CLIs work

```bash
agy --print "say hello" --output-format json
claude -p "say hello" --output-format json
```

Both commands should return a JSON response. Re-authenticate (`agy login` / `claude login`) if either fails.

---

## Quick Start

### 1. Clone

```bash
git clone https://github.com/kikilcmh/AI-CLI-OPEN-API-SWAGGER-.git
cd AI-CLI-OPEN-API-SWAGGER-
```

### 2. Create `.env`

```env
PORT=3986
ADMIN_KEY=your-secret-admin-key

# Optional
CORS_ORIGIN=*
AGY_SKIP_PERMISSIONS=1
AGY_CWD=/home/youruser
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

Every request (except `/health` and `/docs`) requires an `X-Api-Key` header. Two modes:

### Admin Key

Full access — create/delete apps and users, see all data.

```
X-Api-Key: <ADMIN_KEY>
```

### User Key

Scoped to that user's apps. Add `X-App-Id` to target a specific app's session.

```
X-Api-Key: <user api_key>
X-App-Id: <app_id>       ← required for /chat
```

> User keys are generated when you create a user via `POST /users` (admin only).

---

## API Reference

Full interactive documentation is available at `/docs` (Swagger UI).

### Chat

Send a prompt to an app's AI session. The session persists automatically — the first message creates it, subsequent messages resume it.

```
POST /chat
POST /chat/upload        ← multipart: attach images
```

**Request body:**

```json
{
  "prompt": "Explain how transformers work",
  "model": "gemini-2.5-flash",
  "stream": true
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | ✓ | Your message |
| `model` | string | — | Override the app's model for this request |
| `effort` | string | — | `low`, `medium`, `high` — reasoning effort (agy) |
| `stream` | boolean | — | Enable SSE streaming (default `false`) |

**Headers required for chat:**

```
X-Api-Key: <user_api_key>
X-App-Id:  <app_id>
```

or use the admin key with `X-App-Id`.

---

### Auto-routing

Let the LLM decide which backend to use (`agy` for general tasks, `claude` for coding).

```
POST /route
```

Same body as `/chat`. Streaming response includes an extra `route` SSE event indicating the selected tool.

---

### Apps

```http
GET    /apps                     # List your apps (admin sees all)
POST   /apps                     # Create app
GET    /apps/{app_id}            # App detail
DELETE /apps/{app_id}            # Delete app
GET    /apps/{app_id}/messages   # Conversation history
```

**POST /apps body:**

```json
{ "name": "My Bot", "tool": "agy", "model": "gemini-2.5-flash" }
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Display name |
| `tool` | string | ✓ | `agy` or `claude` |
| `model` | string | — | Model ID — see [Models](#models) |

**Response (201):**

```json
{
  "app_id": "uuid",
  "name": "My Bot",
  "owner_user_id": "uuid",
  "tool": "agy",
  "model": "gemini-2.5-flash",
  "session_id": null,
  "created_at": "2026-11-29T..."
}
```

---

### Users *(admin only)*

```http
POST   /users                    # Create user → returns api_key
GET    /users                    # List all users
GET    /users/me                 # Current user info (non-admin)
DELETE /users/{user_id}          # Delete user + all their apps
```

**POST /users body:**

```json
{ "name": "Alice", "external_id": "alice_123" }
```

**Response (201):**

```json
{
  "user_id": "uuid",
  "name": "Alice",
  "api_key": "...",
  "external_id": "alice_123",
  "created_at": "2026-11-29T..."
}
```

> Give the `api_key` to the user — they use it as `X-Api-Key` for all their requests.

---

### Models

```http
GET /models              # Both backends
GET /models?tool=agy     # Antigravity models only
GET /models?tool=claude  # Claude Code models only
```

**Available models:**

| Backend | Model IDs |
|---|---|
| **AGY** (Antigravity) | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash` + others from CLI |
| **Claude** (Anthropic) | `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` |

---

### Usage / Quota

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
      "buckets": [{ "remainingPct": 68, "resetAt": "2026-12-01T15:00:00Z" }]
    }
  ]
}
```

---

## Streaming

All `/chat` and `/route` endpoints support Server-Sent Events when `stream: true`.

```bash
curl -N -X POST http://localhost:3986/chat \
  -H "X-Api-Key: your-user-key" \
  -H "X-App-Id: your-app-id" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello", "stream": true}'
```

**SSE event types:**

| Event | Payload | Description |
|---|---|---|
| `init` | `{ conversation_id }` | Session started |
| `step_update` | `{ text_delta }` or `{ tool_name, state }` | Token delta or tool activity |
| `result` | `{ session_id, response, … }` | Final result |
| `route` | `{ tool }` | *(auto-route only)* Selected backend |
| `error` | `{ error }` | Error occurred |

---

## Image Uploads

Attach images via multipart to the vision endpoint:

```bash
curl -X POST http://localhost:3986/chat/upload \
  -H "X-Api-Key: your-user-key" \
  -H "X-App-Id: your-app-id" \
  -F "prompt=What is in this image?" \
  -F "images=@screenshot.png"
```

Both `agy` and `claude` backends support vision.

---

## Dashboard

Access at `http://localhost:3986/dashboard`

| Section | Description |
|---|---|
| **Overview** | API status, session count, available models |
| **New Chat** | Pick backend and model, start a conversation |
| **Sessions** | Browse and resume all past sessions |
| **Apps** | Create and manage apps |
| **Users** *(admin)* | Create and manage users |
| **API Docs** | Opens Swagger UI |
| **Quota** | Live remaining quota bars — Claude + AGY |

---

## Project Structure

```
.
├── index.js                 # API server — routes, auth, streaming, session logic
├── Dockerfile               # API container image
├── docker-compose.yml       # Orchestration: API + dashboard
├── package.json
├── .env                     # Local config (not committed)
└── dashboard/
    ├── server.js            # Lightweight proxy server (serves static + proxies /api)
    ├── Dockerfile
    ├── package.json
    └── public/
        └── index.html       # Single-page dashboard (vanilla JS)
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | — | API port (default `3986`) |
| `ADMIN_KEY` | ✓ | Admin key for user/app management |
| `CORS_ORIGIN` | — | CORS allowed origin (default `*`) |
| `AGY_SKIP_PERMISSIONS` | — | Skip agy permission prompts (`1` to enable) |
| `AGY_CWD` | — | Working directory for agy file operations |

> Without `ADMIN_KEY` the API runs open — anyone can call it.

---

## License

MIT © 2026
