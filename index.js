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
        'HTTP API wrapper yang mendukung dua LLM tool secara bersamaan:',
        '',
        '| Tool | Nilai `tool` | Deskripsi |',
        '|------|-------------|-----------|',
        '| **Antigravity CLI** | `agy` | Mendukung Gemini, Claude via Google, GPT. Default. |',
        '| **Claude Code CLI** | `claude` | Anthropic Claude langsung. Optimal untuk coding. |',
        '',
        '## Flow Penggunaan',
        '',
        '1. **Ambil daftar model** → `GET /models?tool=agy` atau `GET /models?tool=claude`',
        '2. **Mulai sesi baru** → `POST /chat` dengan field `tool` dan `model`',
        '3. **Lanjut sesi** → `POST /sessions/{session_id}/chat` (tool otomatis mengikuti sesi)',
        '4. **Auto-route** → `POST /route` — LLM classifier kecil (Gemini Flash) otomatis pilih tool terbaik',
        '',
        '## Autentikasi',
        '',
        'Ada tiga mode auth:',
        '',
        '| Mode | Header | Cocok untuk |',
        '|------|--------|-------------|',
        '| **Admin** | `X-Api-Key: <ADMIN_KEY>` | Manage apps & users |',
        '| **App + User** | `X-Api-Key: <app_key>` + `X-User-Id: <user_id>` | Integrasi multi-user |',
        '| **Legacy** | `X-Api-Key: <API_KEYS>` | Backward compat (satu user per key) |',
        '',
        '## Multi-App & Multi-User',
        '',
        '1. Admin buat App → dapat `app_id` dan `api_key`',
        '2. App buat User → dapat `user_id`',
        '3. Tiap request App kirim `X-Api-Key: <app_key>` + `X-User-Id: <user_id>`',
        '4. Sesi otomatis ter-isolasi per `{app_id, user_id}`',
        '',
        '**Isolasi:** Sesi hanya bisa diakses oleh user yang membuatnya. User lain → `403 Forbidden`.',
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
            prompt:  { type: 'string', example: 'Jelaskan apa itu Docker dalam satu paragraf.' },
            tool:    { type: 'string', enum: ['agy', 'claude'], default: 'agy', description: 'LLM tool yang dipakai. `agy` = Antigravity CLI (Gemini/GPT/Claude via Google), `claude` = Claude Code CLI (Anthropic langsung). Untuk sesi lanjutan, tool otomatis mengikuti session.' },
            model:   { type: 'string', example: 'gemini-4-hydrogen-low', description: 'ID model dari `GET /models?tool=agy` atau `GET /models?tool=claude`.' },
            effort:  { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], example: 'low', description: 'Effort level. Tidak semua model support (misal gemini-2.0-flash tidak support effort).' },
            stream:  { type: 'boolean', default: false, description: 'Aktifkan Server-Sent Events (SSE).' },
            images_base64: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array gambar — data URL (`data:image/png;base64,...`) atau plain base64. Didukung oleh `agy` dan `claude`. Untuk `claude`, gunakan model Sonnet/Opus (Haiku tidak mendukung vision).',
              example: ['data:image/png;base64,iVBORw0KGgo='],
            },
          },
        },
        UploadRequest: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt:  { type: 'string', example: 'Apa yang ada di gambar ini?' },
            model:   { type: 'string', example: 'gemini-4-hydrogen-low' },
            effort:  { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
            stream:  { type: 'string', enum: ['true', 'false'], default: 'false' },
            images: {
              type: 'array',
              items: { type: 'string', format: 'binary' },
              description: 'File gambar (jpg, png, webp, dsb). Maks 10 file, 20 MB/file.',
            },
          },
        },
        ChatResponse: {
          type: 'object',
          properties: {
            session_id:      { type: 'string', format: 'uuid', description: 'Alias dari conversation_id. Pakai ini untuk melanjutkan sesi di request berikutnya.' },
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
          description: 'Satu baris NDJSON yang dikirim via SSE.',
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
            preview:       { type: 'string', description: 'Cuplikan pesan pertama.' },
            num_steps:     { type: 'integer' },
            updated_at:    { type: 'string', format: 'date-time' },
            last_modified: { type: 'string', format: 'date-time' },
            workspace:     { type: 'array', items: { type: 'string' }, description: 'Working directories yang dipakai.' },
            tool_used:     { type: 'string', enum: ['agy', 'claude'], description: 'Tool yang dipakai di sesi ini.' },
            model_used:    { type: 'string', description: 'Model yang dipakai saat sesi dibuat.' },
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
            api_key:    { type: 'string', description: 'Key yang dipakai di header X-Api-Key untuk app ini.' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        User: {
          type: 'object',
          properties: {
            user_id:     { type: 'string', format: 'uuid' },
            app_id:      { type: 'string', format: 'uuid' },
            name:        { type: 'string', example: 'John Doe' },
            external_id: { type: 'string', nullable: true, description: 'ID dari sistem eksternal (opsional, harus unik per app).' },
            created_at:  { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    security: [{ ApiKeyHeader: [] }],
  },
  apis: [],
});

// Inject route docs langsung ke spec
swaggerSpec.paths = {
  '/sessions': {
    post: {
      tags: ['Sessions'],
      summary: 'Buat session baru (pre-allocate)',
      description: [
        'Buat session ID sebelum mengirim pesan pertama. Berguna untuk:',
        '- Menyiapkan `session_id` di client sebelum chat',
        '- Menentukan tool & model di awal',
        '',
        'Lanjutkan chat via `POST /sessions/{session_id}/chat`.',
        '',
        '> **Catatan Claude:** `session_id` ini dipakai untuk pesan pertama. Setelah pesan pertama,',
        '> Claude membuat session ID-nya sendiri — gunakan `session_id` dari response chat tersebut',
        '> untuk melanjutkan percakapan.',
      ].join('\n'),
      requestBody: {
        required: false,
        content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            tool:  { type: 'string', enum: ['agy', 'claude'], default: 'agy' },
            model: { type: 'string', example: 'gemini-4-hydrogen-low', description: 'Model yang akan dipakai. Bisa dioverride saat chat.' },
          },
        }, examples: {
          agy:    { summary: 'Buat sesi Antigravity', value: { tool: 'agy', model: 'gemini-4-hydrogen-low' } },
          claude: { summary: 'Buat sesi Claude Code', value: { tool: 'claude', model: 'claude-sonnet-4-6' } },
        }}},
      },
      responses: {
        201: { description: 'Session berhasil dibuat', content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', format: 'uuid' },
            tool:       { type: 'string', enum: ['agy', 'claude'] },
            model:      { type: 'string' },
          },
        }}}},
        400: { description: 'tool tidak valid', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    get: {
      tags: ['Sessions'],
      summary: 'List sesi milik user',
      description: [
        'Mengembalikan semua sesi milik user yang terautentikasi, diurutkan dari yang terbaru.',
        '',
        '**Isolasi user:** Setiap API key hanya melihat sesinya sendiri.',
        'Sesi lama tanpa tag user (dibuat sebelum fitur multi-user) tetap tampil untuk semua user.',
      ].join('\n'),
      parameters: [
        { name: 'limit',  in: 'query', schema: { type: 'integer', default: 20, maximum: 200 }, description: 'Jumlah item per halaman.' },
        { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 }, description: 'Skip N item pertama.' },
        { name: 'q',      in: 'query', schema: { type: 'string' }, description: 'Filter berdasarkan title atau preview.' },
      ],
      responses: {
        200: {
          description: 'Daftar sesi',
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
      summary: 'Detail satu sesi',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: { description: 'Detail sesi', content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Sesi milik user lain', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        404: { description: 'Tidak ditemukan', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/sessions/{id}/tool': {
    get: {
      tags: ['Sessions'],
      summary: 'Tool & model yang dipakai di sesi ini',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: {
          description: 'Info tool sesi',
          content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              tool:   { type: 'string', enum: ['agy', 'claude'] },
              model:  { type: 'string' },
            },
          }}},
        },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Sesi milik user lain', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/sessions/{id}/messages': {
    get: {
      tags: ['Sessions'],
      summary: 'Transcript pesan sesi',
      description: 'Mengembalikan semua pesan (user & assistant) dari sesi ini. Mendukung sesi agy maupun Claude.',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: {
          description: 'Daftar pesan',
          content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
            },
          }}},
        },
        400: { description: 'ID sesi tidak valid', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Sesi milik user lain', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
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
          description: 'Server aktif',
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
      summary: 'List model per tool',
      description: [
        '**Step 1 dari flow:** Ambil daftar model yang tersedia untuk setiap tool.',
        '',
        '- `GET /models?tool=agy` → model Antigravity (Gemini, Claude via Google, GPT)',
        '- `GET /models?tool=claude` → model Claude Code (Anthropic Claude)',
        '- `GET /models` → semua tool sekaligus',
      ].join('\n'),
      parameters: [
        { name: 'tool', in: 'query', schema: { type: 'string', enum: ['agy', 'claude'] }, description: '`agy` = Antigravity CLI, `claude` = Claude Code CLI. Kosong = return semua.' },
      ],
      responses: {
        200: {
          description: 'Daftar model',
          content: { 'application/json': { schema: {
            oneOf: [
              {
                title: 'Response dengan ?tool=agy atau ?tool=claude',
                type: 'object',
                properties: {
                  tool: { type: 'string', example: 'agy' },
                  models: { type: 'array', items: { $ref: '#/components/schemas/Model' } },
                },
              },
              {
                title: 'Response tanpa filter (semua tool)',
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
      summary: 'Sesi baru — kirim prompt',
      description: [
        '**Step 2 dari flow:** Mulai sesi baru dengan tool dan model pilihan.',
        '',
        '### Pilih Tool',
        '| `tool` | LLM | Cocok untuk |',
        '|--------|-----|-------------|',
        '| `agy` _(default)_ | Antigravity CLI | Chat umum, gambar, web search, multi-model |',
        '| `claude` | Claude Code CLI | Coding, debugging, review, software dev |',
        '',
        '### Model',
        'Gunakan `id` dari `GET /models?tool=<tool>` sebagai nilai `model`.',
        '',
        '### Response',
        '- **Non-streaming** (`stream: false`): satu JSON response, berisi `session_id` dan `tool_used`.',
        '- **Streaming** (`stream: true`): SSE — event `init`, `step_update` (stream teks), `result`, `error`.',
        '',
        'Simpan `session_id` dari response untuk melanjutkan sesi di `POST /sessions/{session_id}/chat`.',
      ].join('\n'),
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' },
          examples: {
            agy_gemini: {
              summary: 'Chat dengan Antigravity (Gemini)',
              value: { prompt: 'Jelaskan apa itu Docker.', tool: 'agy', model: 'gemini-4-hydrogen-low', stream: false },
            },
            claude_coding: {
              summary: 'Coding dengan Claude Code',
              value: { prompt: 'Bikin fungsi Python untuk merge dua sorted array.', tool: 'claude', model: 'claude-sonnet-4-6', stream: false },
            },
            streaming: {
              summary: 'Chat streaming (SSE)',
              value: { prompt: 'Ceritakan sejarah singkat AI.', tool: 'agy', model: 'gemini-3.8-flash-low', stream: true },
            },
          },
        }},
      },
      responses: {
        200: {
          description: 'Sukses',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } },
            'text/event-stream': { schema: { $ref: '#/components/schemas/SseEvent' } },
          },
        },
        400: { description: 'prompt wajib diisi', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        500: { description: 'Error dari tool', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/chat/upload': {
    post: {
      tags: ['2. Chat'],
      summary: 'Sesi baru — kirim prompt + gambar (multipart)',
      description: 'Mulai sesi baru dengan gambar. Mendukung `agy` dan `claude` (Sonnet/Opus). Upload hingga 10 file (maks 20 MB/file), dihapus otomatis setelah request.',
      requestBody: {
        required: true,
        content: { 'multipart/form-data': { schema: { $ref: '#/components/schemas/UploadRequest' } } },
      },
      responses: {
        200: { description: 'Sukses', content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } } } },
        400: { description: 'prompt wajib atau format file salah', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        500: { description: 'Error dari tool', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/sessions/{session_id}/chat': {
    post: {
      tags: ['2. Chat'],
      summary: 'Lanjut sesi — kirim prompt',
      description: [
        '**Step 3:** Lanjutkan percakapan yang sudah ada.',
        '',
        'Tool yang dipakai **otomatis mengikuti sesi** (tidak perlu kirim `tool` lagi).',
        'Field `tool` di body diabaikan untuk endpoint ini.',
        '',
        '> Hanya pemilik sesi (API key yang membuat sesi) yang bisa melanjutkannya.',
      ].join('\n'),
      parameters: [
        { name: 'session_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: '`session_id` dari response `POST /chat` atau `POST /sessions`.' },
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' },
          examples: {
            continue: {
              summary: 'Lanjut sesi (tool otomatis)',
              value: { prompt: 'Bisa jelaskan lebih detail?', stream: false },
            },
          },
        }},
      },
      responses: {
        200: {
          description: 'Sukses',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } },
            'text/event-stream': { schema: { $ref: '#/components/schemas/SseEvent' } },
          },
        },
        400: { description: 'prompt wajib diisi', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Sesi milik user lain', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        500: { description: 'Error dari tool', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/route': {
    post: {
      tags: ['3. Auto-Route'],
      summary: 'Auto-route — LLM classifier pilihkan tool',
      description: [
        'Alternatif dari `POST /chat`: kirim prompt, LLM classifier kecil (Gemini Flash) otomatis pilih tool terbaik.',
        '',
        '**Kriteria routing:**',
        '- `claude` → prompt tentang coding, debugging, refactor, code review, programming, software architecture',
        '- `agy` → semua lainnya (pertanyaan umum, creative, chat, gambar, dll)',
        '',
        'SSE streaming: event pertama selalu `{"event":"route","tool":"agy"|"claude"}` sebelum event lainnya.',
      ].join('\n'),
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' },
          examples: {
            coding: {
              summary: 'Prompt coding → akan diroute ke claude',
              value: { prompt: 'Bikin REST API dengan Express.js dan JWT auth.', stream: false },
            },
            general: {
              summary: 'Prompt umum → akan diroute ke agy',
              value: { prompt: 'Apa perbedaan antara machine learning dan deep learning?', stream: false },
            },
          },
        }},
      },
      responses: {
        200: {
          description: 'Sukses — berisi `tool_used` untuk tahu tool yang dipilih',
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
      summary: 'Lanjut sesi dengan auto-route',
      description: 'Lanjutkan sesi yang dimulai via `POST /route`. Tool otomatis mengikuti tool yang dipakai di sesi tersebut.',
      parameters: [
        { name: 'session_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } } } },
      responses: {
        200: { description: 'Sukses', content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Sesi milik user lain', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        500: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/sessions/{session_id}/chat/upload': {
    post: {
      tags: ['2. Chat'],
      summary: 'Lanjut sesi — kirim prompt + gambar (multipart)',
      description: 'Lanjutkan sesi dengan upload gambar. Mendukung `agy` dan `claude`. Untuk `claude`, gunakan model Sonnet/Opus (Haiku tidak mendukung vision).',
      parameters: [
        { name: 'session_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'ID sesi dari response `POST /chat` atau `POST /sessions`.' },
      ],
      requestBody: {
        required: true,
        content: { 'multipart/form-data': { schema: { $ref: '#/components/schemas/UploadRequest' } } },
      },
      responses: {
        200: { description: 'Sukses', content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } } } },
        400: { description: 'prompt wajib atau format file salah', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Sesi milik user lain', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        500: { description: 'Error dari tool', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/apps': {
    post: {
      tags: ['4. Apps'],
      summary: 'Buat app baru',
      description: 'Hanya bisa dipanggil dengan `ADMIN_KEY`. Response berisi `api_key` yang dipakai app untuk request.',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['name'],
        properties: { name: { type: 'string', example: 'Mobile App v1' } },
      }}}},
      responses: {
        201: { description: 'App berhasil dibuat', content: { 'application/json': { schema: { $ref: '#/components/schemas/App' } } } },
        400: { description: 'name wajib diisi', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Admin key required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    get: {
      tags: ['4. Apps'],
      summary: 'List semua app',
      description: 'Hanya bisa dipanggil dengan `ADMIN_KEY`.',
      responses: {
        200: { description: 'Daftar app', content: { 'application/json': { schema: {
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
      summary: 'Detail app',
      description: 'Admin atau app itu sendiri.',
      parameters: [{ name: 'app_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Detail app', content: { 'application/json': { schema: { $ref: '#/components/schemas/App' } } } },
        403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        404: { description: 'App tidak ditemukan', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    delete: {
      tags: ['4. Apps'],
      summary: 'Hapus app beserta semua user-nya',
      description: 'Hanya admin. Semua user dalam app ini ikut dihapus.',
      parameters: [{ name: 'app_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Berhasil dihapus', content: { 'application/json': { schema: { type: 'object', properties: { deleted: { type: 'boolean' } } } } } },
        403: { description: 'Admin key required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        404: { description: 'App tidak ditemukan', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/apps/{app_id}/users': {
    post: {
      tags: ['5. Users'],
      summary: 'Buat user baru dalam app',
      description: 'Admin atau app itu sendiri. Response `user_id` dipakai di header `X-User-Id` saat request chat.',
      parameters: [{ name: 'app_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['name'],
        properties: {
          name:        { type: 'string', example: 'John Doe' },
          external_id: { type: 'string', nullable: true, description: 'ID dari sistem eksternal, opsional. Harus unik per app.', example: 'user-123' },
        },
      }, examples: {
        minimal:  { summary: 'Hanya nama', value: { name: 'Alice' } },
        with_ext: { summary: 'Dengan external_id', value: { name: 'Bob', external_id: 'uid-456' } },
      }}}},
      responses: {
        201: { description: 'User berhasil dibuat', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
        400: { description: 'name wajib diisi', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        409: { description: 'external_id sudah ada di app ini', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    get: {
      tags: ['5. Users'],
      summary: 'List users dalam app',
      parameters: [{ name: 'app_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Daftar user', content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            items: { type: 'array', items: { $ref: '#/components/schemas/User' } },
          },
        }}}},
        403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        404: { description: 'App tidak ditemukan', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/apps/{app_id}/users/{user_id}': {
    get: {
      tags: ['5. Users'],
      summary: 'Detail user',
      parameters: [
        { name: 'app_id',  in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'user_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: { description: 'Detail user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
        403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        404: { description: 'User tidak ditemukan', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    delete: {
      tags: ['5. Users'],
      summary: 'Hapus user',
      parameters: [
        { name: 'app_id',  in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'user_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: { description: 'Berhasil dihapus', content: { 'application/json': { schema: { type: 'object', properties: { deleted: { type: 'boolean' } } } } } },
        403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        404: { description: 'User tidak ditemukan', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
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
