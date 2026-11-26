require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const { randomUUID, createHash } = require('crypto');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

const app = express();

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, X-User-Id, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '50mb' }));

const AGY_BIN = '/usr/local/bin/agy';
const DEFAULT_CWD = process.env.AGY_CWD || process.env.HOME;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'agy-uploads');
const METADATA_FILE = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'cache', 'conversation_metadata.json');
const CACHE_DIR = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'cache');
const APPS_FILE  = path.join(CACHE_DIR, 'apps.json');
const USERS_FILE = path.join(CACHE_DIR, 'users.json');

function loadApps()  { try { return JSON.parse(fs.readFileSync(APPS_FILE,  'utf8')); } catch { return {}; } }
function saveApps(d) { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(APPS_FILE,  JSON.stringify(d, null, 2)); }
function loadUsers()  { try { return JSON.parse(fs.readFileSync(USERS_FILE,  'utf8')); } catch { return {}; } }
function saveUsers(d) { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(USERS_FILE, JSON.stringify(d, null, 2)); }

function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
    return Object.values(raw.conversations || {})
      .filter(c => c?.summary?.ID)
      .map(c => ({
        session_id:    c.summary.ID,
        title:         c.summary.Title || '',
        preview:       c.summary.Preview || '',
        num_steps:     c.summary.NumSteps,
        updated_at:    c.summary.UpdatedAt,
        last_modified: c.last_modified_time,
        workspace:     c.summary.WorkspaceURIs || [],
      }));
  } catch (e) {
    console.error('[sessions] load error:', e.message);
    return [];
  }
}

// Claude sessions are stored in ~/.claude/projects/-workspace/ (cwd inside docker = /workspace)
const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME, '.claude', 'projects', '-workspace');

function loadClaudeSessions() {
  try {
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return [];
    const files = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter(f => f.endsWith('.jsonl'));
    const sessions = [];
    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      const fp = path.join(CLAUDE_PROJECTS_DIR, file);
      try {
        const stat = fs.statSync(fp);
        const lines = fs.readFileSync(fp, 'utf8').trim().split('\n').filter(Boolean);
        let preview = '';
        let title = '';
        let updatedAt = stat.mtime.toISOString();
        for (const line of lines) {
          try {
            const d = JSON.parse(line);
            if (d.type === 'user' && !preview) {
              const content = d.message?.content;
              if (Array.isArray(content)) {
                for (const c of content) {
                  if (c.type === 'text' && c.text) { preview = c.text; break; }
                }
              } else if (typeof content === 'string') {
                preview = content;
              }
            }
            if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle;
            if (d.timestamp && d.timestamp > updatedAt) updatedAt = d.timestamp;
          } catch {}
        }
        sessions.push({
          session_id:    sessionId,
          title:         title,
          preview:       preview.slice(0, 200),
          num_steps:     Math.floor(lines.filter(l => { try { return JSON.parse(l).type === 'assistant'; } catch { return false; } }).length),
          updated_at:    updatedAt,
          last_modified: stat.mtime.toISOString(),
          workspace:     [DEFAULT_CWD],
          _isClaude:     true,
        });
      } catch {}
    }
    return sessions;
  } catch (e) {
    console.error('[claude-sessions] load error:', e.message);
    return [];
  }
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error(`Only image files are allowed, got: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

// Auth
const ADMIN_KEY = process.env.ADMIN_KEY || null;
const LEGACY_KEYS = process.env.API_KEYS
  ? new Set(process.env.API_KEYS.split(',').map(k => k.trim()).filter(Boolean))
  : null;

// Build reverse index: api_key → app_id (refreshed on each lookup for live updates)
function findAppByKey(key) {
  const apps = loadApps();
  return Object.values(apps).find(a => a.api_key === key) || null;
}

function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  // Admin key
  if (ADMIN_KEY && key === ADMIN_KEY) {
    req.isAdmin = true;
    req.userId  = 'admin';
    req.appId   = 'admin';
    return next();
  }

  // Legacy API keys (env API_KEYS) — backward compat
  if (LEGACY_KEYS && key && LEGACY_KEYS.has(key)) {
    req.userId = createHash('sha256').update(key).digest('hex').slice(0, 12);
    req.appId  = 'legacy';
    return next();
  }

  // App key
  const app_ = key ? findAppByKey(key) : null;
  if (app_) {
    req.appId = app_.app_id;
    const uid = req.headers['x-user-id'] || req.body?.user_id || null;
    if (!uid) return res.status(400).json({ error: 'X-User-Id header required for app key auth' });
    const users = loadUsers();
    const user  = users[uid];
    if (!user || user.app_id !== app_.app_id) {
      return res.status(401).json({ error: 'Invalid user_id for this app' });
    }
    req.userId = user.user_id;
    return next();
  }

  // No auth configured — open
  if (!ADMIN_KEY && !LEGACY_KEYS && Object.keys(loadApps()).length === 0) {
    req.userId = 'anonymous';
    req.appId  = 'legacy';
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
}

function adminOnly(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin key required' });
  next();
}

// App-level guard: admin OR the app itself
function appGuard(req, res, next) {
  if (req.isAdmin) return next();
  if (req.appId === req.params.app_id) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// ---------------------------------------------------------------------------
// Single-port proxy: /dashboard and /api
// ---------------------------------------------------------------------------

function httpProxy(targetBase, { reserializeBody = false } = {}) {
  return (req, res) => {
    const url = new URL(targetBase);
    let body = null;
    if (reserializeBody && req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
      body = JSON.stringify(req.body);
    }
    const opts = {
      hostname: url.hostname,
      port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: url.host,
        ...(body != null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      },
    };
    const proxy = http.request(opts, pr => {
      res.writeHead(pr.statusCode, pr.headers);
      pr.pipe(res, { end: true });
    });
    proxy.on('error', err => {
      if (!res.headersSent) res.status(502).json({ error: 'Proxy error', detail: err.message });
    });
    if (body != null) { proxy.write(body); proxy.end(); }
    else req.pipe(proxy, { end: true });
  };
}

// /dashboard → dashboard container (no auth needed, UI is public)
app.use('/dashboard', (req, res, next) => {
  if (!req.url || req.url === '') req.url = '/';
  httpProxy('http://agy-dashboard:3000')(req, res, next);
});

// /api/* → self (strips /api prefix, re-serializes parsed JSON body)
const SELF_PORT = process.env.PORT || 3986;
app.use('/api', httpProxy(`http://localhost:${SELF_PORT}`, { reserializeBody: true }));

// ---------------------------------------------------------------------------

app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/health' || req.path.startsWith('/docs')) return next();
  authMiddleware(req, res, next);
});

app.get('/', (req, res) => res.redirect('/dashboard'));

// ---------------------------------------------------------------------------
// Swagger
// ---------------------------------------------------------------------------
const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'AGY API',
      version: '1.0.0',
      description: [
        '## AGY API — Multi-Model AI Gateway',
        '',
        'A unified HTTP API wrapping two LLM backends:',
        '',
        '| Tool | `tool` value | Description |',
        '|------|-------------|-------------|',
        '| **Antigravity CLI** | `agy` | Gemini, Claude via Google, GPT. Default backend. |',
        '| **Claude Code CLI** | `claude` | Anthropic Claude directly. Best for coding tasks. |',
        '',
        '## Usage Flow',
        '',
        '1. **List models** → `GET /models?tool=agy` or `GET /models?tool=claude`',
        '2. **Start a session** → `POST /chat` with `tool` and `model` fields',
        '3. **Continue session** → `POST /sessions/{session_id}/chat` (tool follows the session automatically)',
        '4. **Auto-route** → `POST /route` — a small classifier (Gemini Flash) picks the best tool automatically',
        '',
        '## Authentication',
        '',
        'Three auth modes, evaluated in order:',
        '',
        '| Mode | Header | Use case |',
        '|------|--------|----------|',
        '| **Admin** | `X-Api-Key: <ADMIN_KEY>` | Manage apps & users |',
        '| **App + User** | `X-Api-Key: <app_key>` + `X-User-Id: <user_id>` | Multi-user integration |',
        '| **Legacy** | `X-Api-Key: <API_KEYS>` | Single-user / backward compat |',
        '',
        '## Multi-App & Multi-User',
        '',
        '1. Admin creates an App → receives `app_id` and `api_key`',
        '2. App creates Users → receives `user_id` per user',
        '3. Each request sends `X-Api-Key: <app_key>` + `X-User-Id: <user_id>`',
        '4. Sessions are automatically isolated per `{app_id, user_id}`',
        '',
        '**Isolation:** Sessions are only accessible by the user who created them. Others → `403 Forbidden`.',
      ].join('\n'),
    },
    components: {
      securitySchemes: {
        ApiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        BearerToken: { type: 'http', scheme: 'bearer' },
      },
      schemas: {
        ChatRequest: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt:  { type: 'string', example: 'Explain what Docker is in one paragraph.' },
            tool:    { type: 'string', enum: ['agy', 'claude'], default: 'agy', description: 'LLM backend to use. `agy` = Antigravity CLI (Gemini/GPT/Claude via Google), `claude` = Claude Code CLI (Anthropic). For existing sessions, the tool follows the session automatically.' },
            model:   { type: 'string', example: 'gemini-4-hydrogen-low', description: 'Model ID from `GET /models?tool=agy` or `GET /models?tool=claude`.' },
            effort:  { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], example: 'low', description: 'Effort level. Not all models support this (e.g. gemini-2.0-flash ignores effort).' },
            stream:  { type: 'boolean', default: false, description: 'Enable Server-Sent Events (SSE) streaming.' },
            images_base64: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of images — data URL (`data:image/png;base64,...`) or plain base64. Supported by both `agy` and `claude`. For `claude`, use Sonnet or Opus (Haiku does not support vision).',
              example: ['data:image/png;base64,iVBORw0KGgo='],
            },
          },
        },
        UploadRequest: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt:  { type: 'string', example: 'What is in this image?' },
            model:   { type: 'string', example: 'gemini-4-hydrogen-low' },
            effort:  { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
            stream:  { type: 'string', enum: ['true', 'false'], default: 'false' },
            images: {
              type: 'array',
              items: { type: 'string', format: 'binary' },
              description: 'Image files (jpg, png, webp, etc.). Max 10 files, 20 MB each.',
            },
          },
        },
        ChatResponse: {
          type: 'object',
          properties: {
            session_id:      { type: 'string', format: 'uuid', description: 'Alias for conversation_id. Use this to continue the session in subsequent requests.' },
            conversation_id: { type: 'string', format: 'uuid' },
            status:          { type: 'string', enum: ['SUCCESS', 'ERROR'] },
            response:        { type: 'string' },
            error:           { type: 'string' },
            duration_seconds:{ type: 'number' },
            num_turns:       { type: 'integer' },
            usage: {
              type: 'object',
              properties: {
                input_tokens:       { type: 'integer' },
                output_tokens:      { type: 'integer' },
                thinking_tokens:    { type: 'integer' },
                cache_read_tokens:  { type: 'integer' },
                total_tokens:       { type: 'integer' },
              },
            },
          },
        },
        SseEvent: {
          type: 'object',
          description: 'A single NDJSON line sent via SSE.',
          properties: {
            event: { type: 'string', enum: ['init', 'step_update', 'result', 'error'] },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
        Session: {
          type: 'object',
          properties: {
            session_id:    { type: 'string', format: 'uuid' },
            title:         { type: 'string' },
            preview:       { type: 'string', description: 'Snippet of the first message.' },
            num_steps:     { type: 'integer' },
            updated_at:    { type: 'string', format: 'date-time' },
            last_modified: { type: 'string', format: 'date-time' },
            workspace:     { type: 'array', items: { type: 'string' }, description: 'Working directories used in this session.' },
            tool_used:     { type: 'string', enum: ['agy', 'claude'], description: 'Backend tool used in this session.' },
            model_used:    { type: 'string', description: 'Model used when the session was created.' },
          },
        },
        Message: {
          type: 'object',
          properties: {
            role:    { type: 'string', enum: ['user', 'assistant'] },
            content: { type: 'string' },
          },
        },
        Model: {
          type: 'object',
          properties: {
            id:   { type: 'string', example: 'gemini-4-hydrogen-low' },
            name: { type: 'string', example: 'Gemini 4 Hydrogen (Low)' },
          },
        },
        App: {
          type: 'object',
          properties: {
            app_id:     { type: 'string', format: 'uuid' },
            name:       { type: 'string', example: 'Mobile App' },
            api_key:    { type: 'string', description: 'Key used in the X-Api-Key header for this app.' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        User: {
          type: 'object',
          properties: {
            user_id:     { type: 'string', format: 'uuid' },
            app_id:      { type: 'string', format: 'uuid' },
            name:        { type: 'string', example: 'John Doe' },
            external_id: { type: 'string', nullable: true, description: 'ID from your external system (optional, must be unique per app).' },
            created_at:  { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    security: [{ ApiKeyHeader: [] }],
  },
  apis: [],
});

// Inject route docs into spec
swaggerSpec.paths = {
  '/sessions': {
    post: {
      tags: ['Sessions'],
      summary: 'Pre-allocate a new session',
      description: [
        'Create a session ID before sending the first message. Useful for:',
        '- Preparing a `session_id` on the client before chatting',
        '- Locking in the tool & model upfront',
        '',
        'Continue the chat via `POST /sessions/{session_id}/chat`.',
        '',
        '> **Claude note:** This `session_id` is used for the first message only. After the first message,',
        '> Claude generates its own session ID — use the `session_id` from the chat response to continue.',
      ].join('\n'),
      requestBody: {
        required: false,
        content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            tool:  { type: 'string', enum: ['agy', 'claude'], default: 'agy' },
            model: { type: 'string', example: 'gemini-4-hydrogen-low', description: 'Model to use. Can be overridden at chat time.' },
          },
        }, examples: {
          agy:    { summary: 'Antigravity session', value: { tool: 'agy', model: 'gemini-4-hydrogen-low' } },
          claude: { summary: 'Claude Code session', value: { tool: 'claude', model: 'claude-sonnet-4-6' } },
        }}},
      },
      responses: {
        201: { description: 'Session created', content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', format: 'uuid' },
            tool:       { type: 'string', enum: ['agy', 'claude'] },
            model:      { type: 'string' },
          },
        }}}},
        400: { description: 'Invalid tool value', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    get: {
      tags: ['Sessions'],
      summary: 'List sessions for the authenticated user',
      description: [
        'Returns all sessions belonging to the authenticated user, sorted by most recent.',
        '',
        '**User isolation:** Each API key only sees its own sessions.',
        'Legacy sessions created before multi-user support was added are visible to all users.',
      ].join('\n'),
      parameters: [
        { name: 'limit',  in: 'query', schema: { type: 'integer', default: 20, maximum: 200 }, description: 'Number of items per page.' },
        { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 }, description: 'Skip first N items.' },
        { name: 'q',      in: 'query', schema: { type: 'string' }, description: 'Filter by title or preview text.' },
      ],
      responses: {
        200: {
          description: 'List of sessions',
          content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              total:  { type: 'integer', example: 42 },
              offset: { type: 'integer', example: 0 },
              limit:  { type: 'integer', example: 20 },
              items:  { type: 'array', items: { $ref: '#/components/schemas/Session' } },
            },
          }}},
        },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/sessions/{id}': {
    get: {
      tags: ['Sessions'],
      summary: 'Get session details',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: { description: 'Session detail', content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Session belongs to another user', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/sessions/{id}/tool': {
    get: {
      tags: ['Sessions'],
      summary: 'Get the tool & model used in this session',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: {
          description: 'Session tool info',
          content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              tool:   { type: 'string', enum: ['agy', 'claude'] },
              model:  { type: 'string' },
            },
          }}},
        },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Session belongs to another user', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/sessions/{id}/messages': {
    get: {
      tags: ['Sessions'],
      summary: 'Get conversation transcript',
      description: 'Returns all messages (user & assistant) for this session. Supports both agy and Claude sessions.',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: {
          description: 'List of messages',
          content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
            },
          }}},
        },
        400: { description: 'Invalid session ID', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Session belongs to another user', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/health': {
    get: {
      tags: ['System'],
      summary: 'Health check',
      security: [],
      responses: {
        200: {
          description: 'Server is running',
          content: { 'application/json': { schema: { type: 'object', properties: {
            status: { type: 'string', example: 'ok' },
            agy:    { type: 'string', example: '/usr/local/bin/agy' },
            auth:   { type: 'string', example: 'enabled' },
          }}}},
        },
      },
    },
  },
  '/models': {
    get: {
      tags: ['1. Tool & Model'],
      summary: 'List available models',
      description: [
        '**Step 1:** Fetch available models for each tool.',
        '',
        '- `GET /models?tool=agy` → Antigravity models (Gemini, Claude via Google, GPT)',
        '- `GET /models?tool=claude` → Claude Code models (Anthropic Claude)',
        '- `GET /models` → all tools at once',
      ].join('\n'),
      parameters: [
        { name: 'tool', in: 'query', schema: { type: 'string', enum: ['agy', 'claude'] }, description: '`agy` = Antigravity CLI, `claude` = Claude Code CLI. Omit to return all.' },
      ],
      responses: {
        200: {
          description: 'List of models',
          content: { 'application/json': { schema: {
            oneOf: [
              {
                title: 'Response with ?tool=agy or ?tool=claude',
                type: 'object',
                properties: {
                  tool: { type: 'string', example: 'agy' },
                  models: { type: 'array', items: { $ref: '#/components/schemas/Model' } },
                },
              },
              {
                title: 'Response without filter (all tools)',
                type: 'object',
                properties: {
                  tools: {
                    type: 'object',
                    example: { agy: { name: 'Antigravity CLI', models: [{ id: 'gemini-4-hydrogen-low', name: 'Gemini 4 Hydrogen (Low)' }] }, claude: { name: 'Claude Code CLI', models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }] } },
                  },
                },
              },
            ],
          }}},
        },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/chat': {
    post: {
      tags: ['2. Chat'],
      summary: 'New session — send a prompt',
      description: [
        '**Step 2:** Start a new session with your chosen tool and model.',
        '',
        '### Choose a Tool',
        '| `tool` | LLM | Best for |',
        '|--------|-----|----------|',
        '| `agy` _(default)_ | Antigravity CLI | General chat, images, web search, multi-model |',
        '| `claude` | Claude Code CLI | Coding, debugging, code review, software dev |',
        '',
        '### Model',
        'Use the `id` from `GET /models?tool=<tool>` as the `model` value.',
        '',
        '### Response',
        '- **Non-streaming** (`stream: false`): single JSON response with `session_id` and `tool_used`.',
        '- **Streaming** (`stream: true`): SSE — events `init`, `step_update` (token stream), `result`, `error`.',
        '',
        'Save `session_id` from the response to continue the session at `POST /sessions/{session_id}/chat`.',
      ].join('\n'),
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' },
          examples: {
            agy_gemini: {
              summary: 'Chat with Antigravity (Gemini)',
              value: { prompt: 'Explain what Docker is.', tool: 'agy', model: 'gemini-4-hydrogen-low', stream: false },
            },
            claude_coding: {
              summary: 'Coding with Claude Code',
              value: { prompt: 'Write a Python function to merge two sorted arrays.', tool: 'claude', model: 'claude-sonnet-4-6', stream: false },
            },
            streaming: {
              summary: 'Streaming chat (SSE)',
              value: { prompt: 'Give a brief history of AI.', tool: 'agy', model: 'gemini-3.8-flash-low', stream: true },
            },
          },
        }},
      },
      responses: {
        200: {
          description: 'Success',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } },
            'text/event-stream': { schema: { $ref: '#/components/schemas/SseEvent' } },
          },
        },
        400: { description: 'prompt is required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        500: { description: 'Tool error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/chat/upload': {
    post: {
      tags: ['2. Chat'],
      summary: 'New session — send prompt + images (multipart)',
      description: 'Start a new session with image attachments. Supports `agy` and `claude` (Sonnet/Opus). Up to 10 files (max 20 MB each), automatically deleted after the request.',
      requestBody: {
        required: true,
        content: { 'multipart/form-data': { schema: { $ref: '#/components/schemas/UploadRequest' } } },
      },
      responses: {
        200: { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } } } },
        400: { description: 'prompt required or invalid file format', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        500: { description: 'Tool error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/sessions/{session_id}/chat': {
    post: {
      tags: ['2. Chat'],
      summary: 'Continue session — send a prompt',
      description: [
        '**Step 3:** Continue an existing conversation.',
        '',
        'The tool **follows the session automatically** — no need to send `tool` again.',
        'The `tool` field in the body is ignored for this endpoint.',
        '',
        '> Only the session owner (the API key that created it) can continue a session.',
      ].join('\n'),
      parameters: [
        { name: 'session_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: '`session_id` from the `POST /chat` or `POST /sessions` response.' },
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' },
          examples: {
            continue: {
              summary: 'Continue session (tool is automatic)',
              value: { prompt: 'Can you explain that in more detail?', stream: false },
            },
          },
        }},
      },
      responses: {
        200: {
          description: 'Success',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } },
            'text/event-stream': { schema: { $ref: '#/components/schemas/SseEvent' } },
          },
        },
        400: { description: 'prompt is required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Session belongs to another user', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        500: { description: 'Tool error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/route': {
    post: {
      tags: ['3. Auto-Route'],
      summary: 'Auto-route — let the LLM classifier pick the tool',
      description: [
        'Alternative to `POST /chat`: send a prompt and a small classifier (Gemini Flash) automatically picks the best tool.',
        '',
        '**Routing criteria:**',
        '- `claude` → prompts about coding, debugging, refactoring, code review, programming, software architecture',
        '- `agy` → everything else (general questions, creative, chat, images, etc.)',
        '',
        'SSE streaming: the first event is always `{"event":"route","tool":"agy"|"claude"}` before any other events.',
      ].join('\n'),
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' },
          examples: {
            coding: {
              summary: 'Coding prompt → will be routed to claude',
              value: { prompt: 'Build a REST API with Express.js and JWT auth.', stream: false },
            },
            general: {
              summary: 'General prompt → will be routed to agy',
              value: { prompt: 'What is the difference between machine learning and deep learning?', stream: false },
            },
          },
        }},
      },
      responses: {
        200: {
          description: 'Success — includes `tool_used` to identify the selected tool',
          content: {
            'application/json': { schema: { allOf: [{ $ref: '#/components/schemas/ChatResponse' }, { type: 'object', properties: { tool_used: { type: 'string', enum: ['agy', 'claude'], example: 'claude' } } }] } },
            'text/event-stream': { schema: { $ref: '#/components/schemas/SseEvent' } },
          },
        },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        500: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/sessions/{session_id}/route': {
    post: {
      tags: ['3. Auto-Route'],
      summary: 'Continue session with auto-route',
      description: 'Continue a session started via `POST /route`. The tool follows the tool used in that session.',
      parameters: [
        { name: 'session_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } } } },
      responses: {
        200: { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Session belongs to another user', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        500: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/sessions/{session_id}/chat/upload': {
    post: {
      tags: ['2. Chat'],
      summary: 'Continue session — send prompt + images (multipart)',
      description: 'Continue a session with image attachments. Supports `agy` and `claude`. For `claude`, use Sonnet or Opus (Haiku does not support vision).',
      parameters: [
        { name: 'session_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Session ID from `POST /chat` or `POST /sessions` response.' },
      ],
      requestBody: {
        required: true,
        content: { 'multipart/form-data': { schema: { $ref: '#/components/schemas/UploadRequest' } } },
      },
      responses: {
        200: { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } } } },
        400: { description: 'prompt required or invalid file format', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Session belongs to another user', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        500: { description: 'Tool error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/apps': {
    post: {
      tags: ['4. Apps'],
      summary: 'Create a new app',
      description: 'Requires `ADMIN_KEY`. Response includes the `api_key` the app uses for requests.',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['name'],
        properties: { name: { type: 'string', example: 'Mobile App v1' } },
      }}}},
      responses: {
        201: { description: 'App created', content: { 'application/json': { schema: { $ref: '#/components/schemas/App' } } } },
        400: { description: 'name is required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Admin key required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    get: {
      tags: ['4. Apps'],
      summary: 'List all apps',
      description: 'Requires `ADMIN_KEY`.',
      responses: {
        200: { description: 'List of apps', content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            items: { type: 'array', items: { $ref: '#/components/schemas/App' } },
          },
        }}}},
        403: { description: 'Admin key required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/apps/{app_id}': {
    get: {
      tags: ['4. Apps'],
      summary: 'Get app details',
      description: 'Accessible by admin or the app itself.',
      parameters: [{ name: 'app_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'App detail', content: { 'application/json': { schema: { $ref: '#/components/schemas/App' } } } },
        403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        404: { description: 'App not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    delete: {
      tags: ['4. Apps'],
      summary: 'Delete app and all its users',
      description: 'Admin only. All users belonging to this app are also deleted.',
      parameters: [{ name: 'app_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Deleted successfully', content: { 'application/json': { schema: { type: 'object', properties: { deleted: { type: 'boolean' } } } } } },
        403: { description: 'Admin key required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        404: { description: 'App not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/apps/{app_id}/users': {
    post: {
      tags: ['5. Users'],
      summary: 'Create a new user in an app',
      description: 'Accessible by admin or the app itself. The returned `user_id` is used in the `X-User-Id` header on chat requests.',
      parameters: [{ name: 'app_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['name'],
        properties: {
          name:        { type: 'string', example: 'John Doe' },
          external_id: { type: 'string', nullable: true, description: 'ID from your external system. Optional, must be unique per app.', example: 'user-123' },
        },
      }, examples: {
        minimal:  { summary: 'Name only', value: { name: 'Alice' } },
        with_ext: { summary: 'With external_id', value: { name: 'Bob', external_id: 'uid-456' } },
      }}}},
      responses: {
        201: { description: 'User created', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
        400: { description: 'name is required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        409: { description: 'external_id already exists in this app', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    get: {
      tags: ['5. Users'],
      summary: 'List users in an app',
      parameters: [{ name: 'app_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'List of users', content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            items: { type: 'array', items: { $ref: '#/components/schemas/User' } },
          },
        }}}},
        403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        404: { description: 'App not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/apps/{app_id}/users/{user_id}': {
    get: {
      tags: ['5. Users'],
      summary: 'Get user details',
      parameters: [
        { name: 'app_id',  in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'user_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: { description: 'User detail', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
        403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        404: { description: 'User not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    delete: {
      tags: ['5. Users'],
      summary: 'Delete a user',
      parameters: [
        { name: 'app_id',  in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'user_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: { description: 'Deleted successfully', content: { 'application/json': { schema: { type: 'object', properties: { deleted: { type: 'boolean' } } } } } },
        403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        404: { description: 'User not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
};

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'AGY API Docs',
  swaggerOptions: { persistAuthorization: true },
  customCss: `
    .swagger-ui .topbar { display: none }
    #dashboard-btn {
      position: fixed; top: 12px; right: 16px; z-index: 9999;
      display: inline-flex; align-items: center; gap: 6px;
      padding: 7px 14px; border-radius: 8px; font-size: 13px; font-weight: 500;
      background: #1e293b; color: #94a3b8; border: 1px solid #334155;
      text-decoration: none; cursor: pointer; transition: all .15s;
    }
    #dashboard-btn:hover { background: #334155; color: #fff; border-color: #4ade80; }
  `,
  customJsStr: `
    window.addEventListener('load', function() {
      var btn = document.createElement('a');
      btn.id = 'dashboard-btn';
      btn.href = window.location.origin + '/dashboard';
      btn.target = '_blank';
      btn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" stroke-linecap="round" stroke-linejoin="round"/></svg> Dashboard';
      document.body.appendChild(btn);
    });
  `,
}));
app.get('/docs.json', (req, res) => res.json(swaggerSpec));

// ---------------------------------------------------------------------------

function runAgy({ prompt, conversationId, model, effort, cwd, images = [], onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const streaming = typeof onChunk === 'function';
    const args = [
      '--print', buildPrompt(prompt, images),
      '--output-format', streaming ? 'stream-json' : 'json',
    ];

    if (process.env.AGY_SKIP_PERMISSIONS === '1') args.push('--dangerously-skip-permissions');
    if (conversationId) args.push('--conversation', conversationId);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);

    const proc = spawn(AGY_BIN, args, { cwd: cwd || DEFAULT_CWD, env: process.env });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (streaming) {
        const lines = stdout.split('\n');
        stdout = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try { onChunk(JSON.parse(line)); } catch {}
        }
      }
    });

    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (!streaming) {
        try { resolve(JSON.parse(stdout.trim())); }
        catch { reject(new Error(`agy exited ${code}: ${stderr || stdout}`)); }
        return;
      }
      if (stdout.trim()) try { onChunk(JSON.parse(stdout.trim())); } catch {}
      if (code !== 0 && stderr) reject(new Error(`agy exited ${code}: ${stderr}`));
      else resolve();
    });

    proc.on('error', reject);
  });
}

function buildPrompt(prompt, images) {
  if (!images || images.length === 0) return prompt;
  return `${prompt}\n${images.map(p => path.resolve(p)).join(' ')}`;
}

function saveBase64Images(b64list) {
  return b64list.map((entry) => {
    let data = entry;
    let ext = '.jpg';
    const match = entry.match(/^data:(image\/(\w+));base64,(.+)$/);
    if (match) {
      ext = `.${match[2]}`;
      data = match[3];
    }
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    const filepath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
    return filepath;
  });
}

function cleanupFiles(files) {
  for (const f of files) try { fs.unlinkSync(f); } catch {}
}

// ---------------------------------------------------------------------------
// POST /chat                        — sesi baru (JSON / base64)
// POST /sessions/:session_id/chat   — lanjut sesi (JSON / base64)
// ---------------------------------------------------------------------------
async function chatHandler(req, res) {
  const sessionId = req.params.session_id || null;
  const { prompt, model, effort, stream, images_base64, tool } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  if (sessionId && !checkSessionOwner(req, res, sessionId)) return;

  // tool: "agy" | "claude" — kalau ada session, pakai tool yang tersimpan
  const resolvedTool = sessionId ? getSessionTool(sessionId) : (tool || 'agy');

  const tempFiles = [];
  try {
    if (Array.isArray(images_base64) && images_base64.length) {
      tempFiles.push(...saveBase64Images(images_base64));
    }
    await handleChat({ res, prompt, conversation_id: sessionId, model, effort, stream, images: tempFiles, tool: resolvedTool, userId: req.userId, appId: req.appId });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    cleanupFiles(tempFiles);
  }
}

app.post('/chat', chatHandler);
app.post('/sessions/:session_id/chat', chatHandler);

// ---------------------------------------------------------------------------
// POST /chat/upload                        — sesi baru (multipart)
// POST /sessions/:session_id/chat/upload   — lanjut sesi (multipart)
// ---------------------------------------------------------------------------
async function uploadHandler(req, res) {
  const sessionId = req.params.session_id || null;
  const { prompt, model, effort, stream, tool } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  if (sessionId && !checkSessionOwner(req, res, sessionId)) return;

  const resolvedTool = sessionId ? getSessionTool(sessionId) : (tool || 'agy');
  const uploadedPaths = (req.files || []).map(f => f.path);
  try {
    await handleChat({ res, prompt, conversation_id: sessionId, model, effort, stream, images: uploadedPaths, tool: resolvedTool, userId: req.userId, appId: req.appId });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    cleanupFiles(uploadedPaths);
  }
}

app.post('/chat/upload', upload.array('images', 10), uploadHandler);
app.post('/sessions/:session_id/chat/upload', upload.array('images', 10), uploadHandler);

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.includes('image')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

const IMAGE_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

function imagesToBase64(paths) {
  return paths.map(fp => {
    const ext = path.extname(fp).slice(1).toLowerCase();
    return { data: fs.readFileSync(fp).toString('base64'), mediaType: IMAGE_MIME[ext] || 'image/jpeg' };
  });
}

async function handleChat({ res, prompt, conversation_id, model, effort, stream, images = [], tool = 'agy', userId = '', appId = '' }) {
  const wantStream = stream === true || stream === 'true' || stream === '1';
  const useClaude = tool === 'claude';
  const claudeImages = useClaude && images.length ? imagesToBase64(images) : [];

  if (wantStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const sendSSE = (data) => {
      if (data.event === 'result' && (data.result?.conversation_id || data.result?.session_id)) {
        const sid = data.result.session_id || data.result.conversation_id;
        data.result.session_id = sid;
        data.result.tool_used = tool;
        saveSessionTool(sid, tool, model, userId, appId);
      }
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    try {
      if (useClaude) {
        await runClaude({ prompt, sessionId: conversation_id, model, effort, images: claudeImages, onChunk: sendSSE });
      } else {
        await runAgy({ prompt, conversationId: conversation_id, model, effort, images, onChunk: sendSSE });
      }
    } catch (err) {
      sendSSE({ event: 'error', error: err.message });
    }
    res.end();
  } else {
    let result;
    if (useClaude) {
      result = await runClaude({ prompt, sessionId: conversation_id, model, effort, images: claudeImages });
    } else {
      const r = await runAgy({ prompt, conversationId: conversation_id, model, effort, images });
      result = { session_id: r.conversation_id, ...r };
    }
    result.tool_used = tool;
    saveSessionTool(result.session_id, tool, model, userId, appId);
    res.json(result);
  }
}

// GET /sessions?limit=20&offset=0&q=keyword
app.get('/sessions', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '20', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  const q      = (req.query.q || '').toLowerCase();
  const userId = req.userId;

  const agyList = loadSessions();
  const claudeList = loadClaudeSessions();
  const agyIds = new Set(agyList.map(s => s.session_id));

  let list = [...agyList, ...claudeList.filter(s => !agyIds.has(s.session_id))]
    .sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));

  if (q) {
    list = list.filter(c =>
      c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q)
    );
  }

  // Only show sessions owned by this user/app (untagged legacy sessions visible to all)
  list = list.filter(s => {
    const sd = getSessionData(s.session_id);
    if (req.isAdmin) return true;
    const userMatch = !sd.userId || sd.userId === userId;
    const appMatch  = !sd.appId  || sd.appId === 'legacy' || sd.appId === req.appId;
    return userMatch && appMatch;
  });

  const items = list.slice(offset, offset + limit).map(s => {
    const sd = getSessionData(s.session_id);
    // For Claude-dir sessions not yet in session_tools.json, default tool to 'claude'
    const toolUsed = (sd.tool === 'agy' && s._isClaude) ? 'claude' : sd.tool;
    const { _isClaude, ...rest } = s;
    return { ...rest, tool_used: toolUsed, model_used: sd.model };
  });

  res.json({ total: list.length, offset, limit, items });
});

// POST /sessions — buat session baru (init ping ke tool untuk dapat session_id nyata)
app.post('/sessions', async (req, res) => {
  const { tool = 'agy', model = '' } = req.body;
  if (!['agy', 'claude'].includes(tool)) return res.status(400).json({ error: 'tool must be "agy" or "claude"' });
  try {
    let sessionId;
    if (tool === 'claude') {
      const r = await runClaude({ prompt: '.', model });
      sessionId = r.session_id;
    } else {
      const r = await runAgy({ prompt: '.', model });
      sessionId = r.conversation_id;
    }
    if (!sessionId) throw new Error('Tool did not return a session_id');
    saveSessionTool(sessionId, tool, model, req.userId, req.appId);
    res.status(201).json({ session_id: sessionId, tool, model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// App & User management
// ---------------------------------------------------------------------------

// POST /apps — buat app baru (admin only)
app.post('/apps', adminOnly, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const apps = loadApps();
  const app_id  = randomUUID();
  const api_key = require('crypto').randomBytes(24).toString('hex');
  apps[app_id] = { app_id, name, api_key, created_at: new Date().toISOString() };
  saveApps(apps);
  res.status(201).json(apps[app_id]);
});

// GET /apps — list semua app (admin only)
app.get('/apps', adminOnly, (req, res) => {
  const apps = loadApps();
  res.json({ total: Object.keys(apps).length, items: Object.values(apps) });
});

// GET /apps/:app_id — detail app
app.get('/apps/:app_id', appGuard, (req, res) => {
  const apps = loadApps();
  const a = apps[req.params.app_id];
  if (!a) return res.status(404).json({ error: 'App not found' });
  res.json(a);
});

// DELETE /apps/:app_id — hapus app (admin only)
app.delete('/apps/:app_id', adminOnly, (req, res) => {
  const apps = loadApps();
  if (!apps[req.params.app_id]) return res.status(404).json({ error: 'App not found' });
  delete apps[req.params.app_id];
  saveApps(apps);
  // Hapus semua user milik app ini
  const users = loadUsers();
  for (const uid of Object.keys(users)) {
    if (users[uid].app_id === req.params.app_id) delete users[uid];
  }
  saveUsers(users);
  res.json({ deleted: true });
});

// POST /apps/:app_id/users — buat user baru
app.post('/apps/:app_id/users', appGuard, (req, res) => {
  const apps = loadApps();
  if (!apps[req.params.app_id]) return res.status(404).json({ error: 'App not found' });
  const { name, external_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const users = loadUsers();
  // Cek duplikat external_id dalam app yang sama
  if (external_id) {
    const dup = Object.values(users).find(u => u.app_id === req.params.app_id && u.external_id === external_id);
    if (dup) return res.status(409).json({ error: 'external_id already exists in this app', user_id: dup.user_id });
  }
  const user_id = randomUUID();
  users[user_id] = { user_id, app_id: req.params.app_id, name, external_id: external_id || null, created_at: new Date().toISOString() };
  saveUsers(users);
  res.status(201).json(users[user_id]);
});

// GET /apps/:app_id/users — list users dalam app
app.get('/apps/:app_id/users', appGuard, (req, res) => {
  const apps = loadApps();
  if (!apps[req.params.app_id]) return res.status(404).json({ error: 'App not found' });
  const users = loadUsers();
  const items = Object.values(users).filter(u => u.app_id === req.params.app_id);
  res.json({ total: items.length, items });
});

// GET /apps/:app_id/users/:user_id — detail user
app.get('/apps/:app_id/users/:user_id', appGuard, (req, res) => {
  const users = loadUsers();
  const u = users[req.params.user_id];
  if (!u || u.app_id !== req.params.app_id) return res.status(404).json({ error: 'User not found' });
  res.json(u);
});

// DELETE /apps/:app_id/users/:user_id — hapus user
app.delete('/apps/:app_id/users/:user_id', appGuard, (req, res) => {
  const users = loadUsers();
  const u = users[req.params.user_id];
  if (!u || u.app_id !== req.params.app_id) return res.status(404).json({ error: 'User not found' });
  delete users[req.params.user_id];
  saveUsers(users);
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------

// GET /sessions/:id
app.get('/sessions/:id', (req, res) => {
  const id = req.params.id;
  if (!checkSessionOwner(req, res, id)) return;
  const conv = loadSessions().find(c => c.session_id === id);
  if (!conv) return res.status(404).json({ error: 'Session not found' });
  const sd = getSessionData(id);
  res.json({ ...conv, tool_used: sd.tool, model_used: sd.model });
});

// ---------------------------------------------------------------------------
// Router: LLM classifier + runClaude
// ---------------------------------------------------------------------------
const SESSION_TOOLS_FILE = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'cache', 'session_tools.json');

function getSessionTool(id) {
  try {
    const entry = JSON.parse(fs.readFileSync(SESSION_TOOLS_FILE, 'utf8'))[id];
    if (!entry) return 'agy';
    return typeof entry === 'string' ? entry : (entry.tool || 'agy');
  } catch { return 'agy'; }
}

function getSessionData(id) {
  try {
    const entry = JSON.parse(fs.readFileSync(SESSION_TOOLS_FILE, 'utf8'))[id];
    if (!entry) return { tool: 'agy', model: '', userId: '', appId: '' };
    if (typeof entry === 'string') return { tool: entry, model: '', userId: '', appId: '' };
    return { tool: entry.tool || 'agy', model: entry.model || '', userId: entry.userId || '', appId: entry.appId || '' };
  } catch { return { tool: 'agy', model: '', userId: '', appId: '' }; }
}

function saveSessionTool(id, tool, model, userId, appId) {
  try {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(SESSION_TOOLS_FILE, 'utf8')); } catch {}
    const prev = data[id];
    data[id] = {
      tool,
      model:  model  || (prev && typeof prev === 'object' ? prev.model  : '') || '',
      userId: userId || (prev && typeof prev === 'object' ? prev.userId : '') || '',
      appId:  appId  || (prev && typeof prev === 'object' ? prev.appId  : '') || '',
    };
    fs.writeFileSync(SESSION_TOOLS_FILE, JSON.stringify(data));
  } catch {}
}

// Returns false and sends 403 if session is owned by a different user/app.
function checkSessionOwner(req, res, sessionId) {
  if (req.isAdmin) return true;
  const sd = getSessionData(sessionId);
  if (sd.userId && req.userId && sd.userId !== req.userId) {
    res.status(403).json({ error: 'Forbidden: session belongs to another user' });
    return false;
  }
  if (sd.appId && req.appId && sd.appId !== 'legacy' && sd.appId !== req.appId) {
    res.status(403).json({ error: 'Forbidden: session belongs to another app' });
    return false;
  }
  return true;
}

async function runRouter(prompt) {
  const routerPrompt = `You are a request router. Reply with ONLY a JSON object, no markdown, no explanation.

Route to "claude" for: writing/debugging/reviewing code, programming, software architecture, APIs, databases, DevOps, file operations.
Route to "agy" for: general questions, creative writing, translation, math, chat, images, general knowledge.

Respond ONLY with: {"tool":"claude"} or {"tool":"agy"}

Request: ${JSON.stringify(prompt.slice(0, 400))}`;

  try {
    const result = await runAgy({ prompt: routerPrompt, model: 'gemini-3.8-flash-low' });
    const text = result.response.trim().replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const json = JSON.parse(text);
    return json.tool === 'claude' ? 'claude' : 'agy';
  } catch {
    return 'agy';
  }
}

const CLAUDE_BIN = '/usr/bin/claude';

function runClaude({ prompt, sessionId, model, effort, images = [], onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const streaming = typeof onChunk === 'function';
    const hasImages = images.length > 0;
    // --input-format stream-json requires --output-format stream-json
    const useStreamJson = streaming || hasImages;

    const args = ['-p', '--dangerously-skip-permissions'];
    if (useStreamJson) args.push('--output-format', 'stream-json', '--verbose');
    else args.push('--output-format', 'json');
    if (hasImages) args.push('--input-format', 'stream-json');
    // Only resume if Claude session file exists (pre-allocated sessions don't have a file yet)
    if (sessionId && fs.existsSync(path.join(CLAUDE_PROJECTS_DIR, `${sessionId}.jsonl`))) {
      args.push('-r', sessionId);
    }
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);

    const proc = spawn(CLAUDE_BIN, args, { cwd: DEFAULT_CWD, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });

    if (hasImages) {
      const content = [
        { type: 'text', text: prompt },
        ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
      ];
      proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
    } else {
      proc.stdin.write(prompt);
    }
    proc.stdin.end();

    let stdout = '';
    let claudeSessionId = null;
    let collectedResult = null;

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (!useStreamJson) return;
      const lines = stdout.split('\n');
      stdout = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'system' && ev.session_id) {
            claudeSessionId = ev.session_id;
            if (streaming) onChunk({ event: 'init', conversation_id: ev.session_id, tool_used: 'claude', init: {} });
          } else if (ev.type === 'assistant') {
            const text = (ev.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
            if (text && streaming) onChunk({ event: 'step_update', step_update: { conversation_id: ev.session_id, step_type: 'agent_response', state: 'ACTIVE', text_delta: text } });
          } else if (ev.type === 'result') {
            claudeSessionId = ev.session_id || claudeSessionId;
            const r = { conversation_id: claudeSessionId, session_id: claudeSessionId, status: ev.is_error ? 'ERROR' : 'SUCCESS', response: ev.result || '', tool_used: 'claude' };
            if (streaming) onChunk({ event: 'result', result: r });
            else collectedResult = r;
          }
        } catch {}
      }
    });

    proc.on('close', (code) => {
      if (!useStreamJson) {
        try {
          const d = JSON.parse(stdout.trim());
          resolve({ session_id: d.session_id, conversation_id: d.session_id, status: d.is_error ? 'ERROR' : 'SUCCESS', response: d.result || '', tool_used: 'claude' });
        } catch { reject(new Error(`claude exited ${code}`)); }
        return;
      }
      if (stdout.trim()) {
        try {
          const ev = JSON.parse(stdout.trim());
          if (ev.type === 'result') {
            const r = { session_id: ev.session_id, status: 'SUCCESS', response: ev.result || '', tool_used: 'claude' };
            if (streaming) onChunk({ event: 'result', result: r });
            else collectedResult = r;
          }
        } catch {}
      }
      if (!streaming) resolve(collectedResult || { status: 'ERROR', response: 'No response', tool_used: 'claude' });
      else resolve();
    });

    proc.on('error', reject);
  });
}

// POST /route  &  POST /sessions/:session_id/route
async function routeHandler(req, res) {
  const sessionId = req.params.session_id || null;
  const { prompt, model, effort, stream } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  if (sessionId && !checkSessionOwner(req, res, sessionId)) return;

  let tool;
  if (sessionId) {
    tool = getSessionTool(sessionId);
  } else {
    tool = await runRouter(prompt);
  }

  const userId = req.userId;
  const appId  = req.appId;
  const wantStream = stream === true || stream === 'true' || stream === '1';

  if (wantStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ event: 'route', tool });

    try {
      if (tool === 'claude') {
        await runClaude({ prompt, sessionId, model, effort, onChunk: (ev) => {
          if (ev.event === 'result' && ev.result?.session_id) saveSessionTool(ev.result.session_id, 'claude', model, userId, appId);
          send(ev);
        }});
      } else {
        await runAgy({ prompt, conversationId: sessionId, model, effort, images: [], onChunk: (ev) => {
          if (ev.event === 'result' && ev.result) { ev.result.session_id = ev.result.session_id || ev.result.conversation_id; ev.result.tool_used = 'agy'; if (ev.result.session_id) saveSessionTool(ev.result.session_id, 'agy', model, userId, appId); }
          send(ev);
        }});
      }
    } catch (err) { send({ event: 'error', error: err.message }); }
    res.end();
  } else {
    try {
      let result;
      if (tool === 'claude') {
        result = await runClaude({ prompt, sessionId, model, effort });
        saveSessionTool(result.session_id, 'claude', model, userId, appId);
      } else {
        const r = await runAgy({ prompt, conversationId: sessionId, model, effort, images: [] });
        result = { session_id: r.conversation_id, ...r, tool_used: 'agy' };
        saveSessionTool(result.session_id, 'agy', model, userId, appId);
      }
      res.json({ ...result, tool_used: tool });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
}

app.post('/route', routeHandler);
app.post('/sessions/:session_id/route', routeHandler);

// GET /sessions/:id/tool — tool & model yang dipakai di session ini
app.get('/sessions/:id/tool', (req, res) => {
  if (!checkSessionOwner(req, res, req.params.id)) return;
  res.json(getSessionData(req.params.id));
});

// GET /sessions/:id/messages — baca transcript agy atau Claude
app.get('/sessions/:id/messages', (req, res) => {
  const id = req.params.id;
  if (!/^[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ error: 'Invalid session ID' });
  if (!checkSessionOwner(req, res, id)) return;

  const tool = getSessionTool(id);

  // --- Claude session ---
  if (tool === 'claude') {
    const claudeFile = path.join(CLAUDE_PROJECTS_DIR, `${id}.jsonl`);
    if (!fs.existsSync(claudeFile)) return res.json({ messages: [] });
    try {
      const lines = fs.readFileSync(claudeFile, 'utf8').trim().split('\n').filter(Boolean);
      const messages = [];
      for (const line of lines) {
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        if (d.isSidechain) continue;
        const content = d.message?.content;
        if (!content) continue;
        const texts = Array.isArray(content)
          ? content.filter(c => c?.type === 'text' && c.text).map(c => c.text).join('')
          : (typeof content === 'string' ? content : '');
        if (!texts.trim()) continue;
        if (d.type === 'user') messages.push({ role: 'user', content: texts.trim() });
        else if (d.type === 'assistant') messages.push({ role: 'assistant', content: texts.trim() });
      }
      return res.json({ messages });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // --- agy session ---
  const transcriptPath = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(transcriptPath)) return res.json({ messages: [] });

  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n').filter(Boolean);
    const messages = [];
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const { type, source, status, content } = entry;
      if (!content || status !== 'DONE') continue;

      if (type === 'USER_INPUT' && source === 'USER_EXPLICIT') {
        let text = String(content);
        const match = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
        if (match) text = match[1].trim();
        text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*$/, '').trim();
        text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*$/, '').trim();
        if (text) messages.push({ role: 'user', content: text });
      } else if (type === 'PLANNER_RESPONSE' && source === 'MODEL' && String(content).trim()) {
        messages.push({ role: 'assistant', content: String(content).trim() });
      }
    }
    res.json({ messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const CLAUDE_MODELS = [
  { id: 'claude-opus-4-8',          name: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-4-6',        name: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001',name: 'Claude Haiku 4.5' },
];

app.get('/models', (req, res) => {
  const tool = req.query.tool;
  if (tool === 'claude') return res.json({ tool: 'claude', models: CLAUDE_MODELS });

  const proc = spawn(AGY_BIN, ['models'], { env: process.env });
  let out = '';
  proc.stdout.on('data', d => out += d);
  proc.on('close', () => {
    const agyModels = out.trim().split('\n').filter(Boolean).map(line => {
      const [id, ...rest] = line.split('\t');
      return { id: id.trim(), name: rest.join(' ').trim(), tool: 'agy' };
    });
    if (tool === 'agy') return res.json({ tool: 'agy', models: agyModels });
    res.json({
      tools: {
        agy:    { name: 'Antigravity CLI', models: agyModels },
        claude: { name: 'Claude Code CLI', models: CLAUDE_MODELS },
      },
    });
  });
  proc.on('error', err => res.status(500).json({ error: err.message }));
});

app.get('/usage', (req, res) => {
  function runCmd(bin, args) {
    return new Promise(resolve => {
      let out = '';
      const p = spawn(bin, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      p.stdout.on('data', d => { out += d; });
      p.on('close', () => resolve(out));
      p.on('error', () => resolve(''));
    });
  }

  Promise.all([
    runCmd(CLAUDE_BIN, ['--print', '/usage', '--output-format', 'json']),
    runCmd(AGY_BIN,    ['--print', '/usage', '--output-format', 'json']),
  ]).then(([claudeOut, agyOut]) => {
    const result = {};

    // --- Claude ---
    try {
      const d = JSON.parse(claudeOut);
      const text = d.result || '';
      const sessionMatch = text.match(/Current session:\s+(\d+)%\s+used[^·\n]*·?\s*(?:resets\s+([^\n]+))?/);
      const weekMatch    = text.match(/Current week[^:]*:\s+(\d+)%\s+used[^·\n]*·?\s*(?:resets\s+([^\n]+))?/);
      result.claude = {
        session: sessionMatch ? { usedPct: parseInt(sessionMatch[1]), resetAt: (sessionMatch[2] || '').trim() } : null,
        week:    weekMatch    ? { usedPct: parseInt(weekMatch[1]),    resetAt: (weekMatch[2]    || '').trim() } : null,
      };
    } catch { result.claude = null; }

    // --- AGY ---
    try {
      const d = JSON.parse(agyOut);
      const groups = d.command?.data?.groups || [];
      result.agy = groups.map(g => ({
        name: g.name,
        buckets: (g.buckets || []).map(b => ({
          name: b.name,
          remainingPct: Math.round((b.remaining_fraction || 0) * 100),
          resetAt: b.reset_time || '',
        })),
      }));
    } catch { result.agy = null; }

    res.json(result);
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', agy: AGY_BIN, auth: (ADMIN_KEY || LEGACY_KEYS) ? 'enabled' : 'open' });
});

const PORT = process.env.PORT || 3986;
app.listen(PORT, () => {
  console.log(`agy API running on port ${PORT}`);
  console.log(`docs:  http://localhost:${PORT}/docs`);
  console.log(`auth:  admin=${ADMIN_KEY ? 'yes' : 'no'}, legacy_keys=${LEGACY_KEYS ? LEGACY_KEYS.size : 0}, apps=${Object.keys(loadApps()).length}`);
  console.log(`upload dir: ${UPLOAD_DIR}`);
});
