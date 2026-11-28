require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, X-App-Id, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '50mb' }));

const AGY_BIN      = '/usr/local/bin/agy';
const CLAUDE_BIN   = '/usr/bin/claude';
const DEFAULT_CWD  = process.env.AGY_CWD || process.env.HOME;
const UPLOAD_DIR   = process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'agy-uploads');
const CACHE_DIR    = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'cache');
const USERS_FILE   = path.join(CACHE_DIR, 'users.json');
const APPS_FILE    = path.join(CACHE_DIR, 'apps.json');
const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME, '.claude', 'projects', '-workspace');

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function loadApps()   { try { return JSON.parse(fs.readFileSync(APPS_FILE,  'utf8')); } catch { return {}; } }
function saveApps(d)  { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(APPS_FILE,  JSON.stringify(d, null, 2)); }
function loadUsers()  { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; } }
function saveUsers(d) { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(USERS_FILE, JSON.stringify(d, null, 2)); }

function findUserByKey(key) {
  if (!key) return null;
  return Object.values(loadUsers()).find(u => u.api_key === key) || null;
}

function saveAppSession(appId, sessionId) {
  if (!appId || !sessionId) return;
  const apps = loadApps();
  if (apps[appId] && !apps[appId].session_id) {
    apps[appId].session_id = sessionId;
    saveApps(apps);
  }
}

// ---------------------------------------------------------------------------
// Session readers (internal — agy & claude)
// ---------------------------------------------------------------------------

const METADATA_FILE = path.join(CACHE_DIR, 'conversation_metadata.json');

function loadAgySessions() {
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
        let preview = '', title = '', updatedAt = stat.mtime.toISOString();
        for (const line of lines) {
          try {
            const d = JSON.parse(line);
            if (d.type === 'user' && !preview) {
              const content = d.message?.content;
              if (Array.isArray(content)) {
                for (const c of content) { if (c.type === 'text' && c.text) { preview = c.text; break; } }
              } else if (typeof content === 'string') preview = content;
            }
            if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle;
            if (d.timestamp && d.timestamp > updatedAt) updatedAt = d.timestamp;
          } catch {}
        }
        sessions.push({
          session_id:    sessionId,
          title,
          preview:       preview.slice(0, 200),
          num_steps:     Math.floor(lines.filter(l => { try { return JSON.parse(l).type === 'assistant'; } catch { return false; } }).length),
          updated_at:    updatedAt,
          last_modified: stat.mtime.toISOString(),
          workspace:     [DEFAULT_CWD],
        });
      } catch {}
    }
    return sessions;
  } catch (e) {
    console.error('[claude-sessions] load error:', e.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// File upload
// ---------------------------------------------------------------------------

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
    if (!file.mimetype.startsWith('image/')) return cb(new Error(`Only image files are allowed, got: ${file.mimetype}`));
    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const ADMIN_KEY = process.env.ADMIN_KEY || null;

function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (ADMIN_KEY && key === ADMIN_KEY) {
    req.isAdmin = true;
    req.userId  = 'admin';
    req.appId   = null;
    return next();
  }

  const user = findUserByKey(key);
  if (user) {
    req.userId = user.user_id;
    req.appId  = null;

    const appId = req.headers['x-app-id'];
    if (appId) {
      const apps = loadApps();
      const appObj = apps[appId];
      if (!appObj || appObj.owner_user_id !== user.user_id) {
        return res.status(403).json({ error: 'App not found or not owned by this user' });
      }
      req.appId = appId;
    }
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
}

function adminOnly(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin key required' });
  next();
}

function appOwnerGuard(req, res, next) {
  if (req.isAdmin) return next();
  const apps = loadApps();
  const appObj = apps[req.params.app_id];
  if (!appObj) return res.status(404).json({ error: 'App not found' });
  if (appObj.owner_user_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
  next();
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

app.use('/dashboard', (req, res, next) => {
  if (!req.url || req.url === '') req.url = '/';
  httpProxy('http://agy-dashboard:3000')(req, res, next);
});

const SELF_PORT = process.env.PORT || 3986;
app.use('/api', httpProxy(`http://localhost:${SELF_PORT}`, { reserializeBody: true }));

// ---------------------------------------------------------------------------
// Auth middleware (skip public routes)
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
      version: '2.0.0',
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
        '1. Admin creates a **User** → user receives their `api_key`',
        '2. User creates an **App** → chooses tool & model → receives `app_id`',
        '3. Each App has **one persistent CLI session** — chat continues automatically',
        '4. Send `POST /chat` with `X-Api-Key` + `X-App-Id` to chat',
        '',
        '## Authentication',
        '',
        '| Header | Value | Required |',
        '|--------|-------|----------|',
        '| `X-Api-Key` | User API key or Admin key | Always |',
        '| `X-App-Id` | App ID | For chat |',
      ].join('\n'),
    },
    components: {
      securitySchemes: {
        ApiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        AppIdHeader:  { type: 'apiKey', in: 'header', name: 'X-App-Id' },
      },
      schemas: {
        User: {
          type: 'object',
          properties: {
            user_id:     { type: 'string', format: 'uuid' },
            name:        { type: 'string' },
            api_key:     { type: 'string' },
            external_id: { type: 'string', nullable: true },
            created_at:  { type: 'string', format: 'date-time' },
          },
        },
        App: {
          type: 'object',
          properties: {
            app_id:         { type: 'string', format: 'uuid' },
            name:           { type: 'string' },
            owner_user_id:  { type: 'string', format: 'uuid' },
            session_id:     { type: 'string', nullable: true, description: 'CLI session ID, created on first chat.' },
            tool:           { type: 'string', enum: ['agy', 'claude'] },
            model:          { type: 'string' },
            created_at:     { type: 'string', format: 'date-time' },
          },
        },
        ChatRequest: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt:  { type: 'string' },
            model:   { type: 'string', description: 'Override the app\'s model for this request.' },
            effort:  { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
            stream:  { type: 'boolean', default: false },
            images_base64: { type: 'array', items: { type: 'string' } },
          },
        },
        ChatResponse: {
          type: 'object',
          properties: {
            session_id:       { type: 'string' },
            status:           { type: 'string', enum: ['SUCCESS', 'ERROR'] },
            response:         { type: 'string' },
            tool_used:        { type: 'string', enum: ['agy', 'claude'] },
            duration_seconds: { type: 'number' },
          },
        },
        Message: {
          type: 'object',
          properties: {
            role:    { type: 'string', enum: ['user', 'assistant'] },
            content: { type: 'string' },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
        Model: {
          type: 'object',
          properties: {
            id:   { type: 'string' },
            name: { type: 'string' },
          },
        },
      },
    },
    security: [{ ApiKeyHeader: [] }],
  },
  apis: [],
});

swaggerSpec.paths = {
  '/users': {
    post: {
      tags: ['1. Users (Admin)'],
      summary: 'Create a new user',
      description: 'Admin only. Returns the user including their `api_key`.',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['name'],
        properties: { name: { type: 'string' }, external_id: { type: 'string', nullable: true } },
      }}}},
      responses: {
        201: { description: 'User created', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
        400: { description: 'name required' },
        403: { description: 'Admin key required' },
        409: { description: 'external_id already exists' },
      },
    },
    get: {
      tags: ['1. Users (Admin)'],
      summary: 'List all users',
      description: 'Admin only.',
      responses: {
        200: { description: 'Users list', content: { 'application/json': { schema: { type: 'object', properties: { total: { type: 'integer' }, items: { type: 'array', items: { $ref: '#/components/schemas/User' } } } } } } },
        403: { description: 'Admin key required' },
      },
    },
  },
  '/users/me': {
    get: {
      tags: ['1. Users (Admin)'],
      summary: 'Get current user info',
      responses: {
        200: { description: 'Current user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
      },
    },
  },
  '/users/{user_id}': {
    delete: {
      tags: ['1. Users (Admin)'],
      summary: 'Delete a user and all their apps',
      parameters: [{ name: 'user_id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Deleted' },
        403: { description: 'Admin key required' },
        404: { description: 'User not found' },
      },
    },
  },
  '/apps': {
    post: {
      tags: ['2. Apps'],
      summary: 'Create a new app',
      description: 'Creates an app owned by the authenticated user. Each app has one persistent CLI session.',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['name'],
        properties: {
          name:  { type: 'string', example: 'My Assistant' },
          tool:  { type: 'string', enum: ['agy', 'claude'], default: 'agy' },
          model: { type: 'string', example: 'gemini-2.5-pro' },
        },
      }}}},
      responses: {
        201: { description: 'App created', content: { 'application/json': { schema: { $ref: '#/components/schemas/App' } } } },
        400: { description: 'name required or invalid tool' },
      },
    },
    get: {
      tags: ['2. Apps'],
      summary: 'List apps',
      description: 'Returns apps owned by the authenticated user. Admin sees all apps.',
      responses: {
        200: { description: 'Apps list', content: { 'application/json': { schema: { type: 'object', properties: { total: { type: 'integer' }, items: { type: 'array', items: { $ref: '#/components/schemas/App' } } } } } } },
      },
    },
  },
  '/apps/{app_id}': {
    get: {
      tags: ['2. Apps'],
      summary: 'Get app details',
      parameters: [{ name: 'app_id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'App detail', content: { 'application/json': { schema: { $ref: '#/components/schemas/App' } } } },
        403: { description: 'Forbidden' },
        404: { description: 'Not found' },
      },
    },
    delete: {
      tags: ['2. Apps'],
      summary: 'Delete an app',
      parameters: [{ name: 'app_id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Deleted' },
        403: { description: 'Forbidden' },
        404: { description: 'Not found' },
      },
    },
  },
  '/apps/{app_id}/messages': {
    get: {
      tags: ['2. Apps'],
      summary: 'Get app conversation history',
      description: 'Returns all messages from the app\'s CLI session.',
      parameters: [{ name: 'app_id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Messages', content: { 'application/json': { schema: { type: 'object', properties: { messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } } } } } } },
        403: { description: 'Forbidden' },
        404: { description: 'Not found' },
      },
    },
  },
  '/chat': {
    post: {
      tags: ['3. Chat'],
      summary: 'Send a message to an app',
      description: [
        'Send `X-App-Id` header to chat within an app\'s persistent session.',
        '',
        'On the first message, the CLI session is created and saved to the app.',
        'Subsequent messages automatically continue the same session.',
        '',
        '**Streaming** (`stream: true`): SSE events — `init`, `step_update`, `result`, `error`.',
      ].join('\n'),
      security: [{ ApiKeyHeader: [], AppIdHeader: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } } } },
      responses: {
        200: { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } }, 'text/event-stream': {} } },
        400: { description: 'prompt required' },
        403: { description: 'App not owned by user' },
      },
    },
  },
  '/chat/upload': {
    post: {
      tags: ['3. Chat'],
      summary: 'Send a message with images (multipart)',
      security: [{ ApiKeyHeader: [], AppIdHeader: [] }],
      requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, stream: { type: 'string' }, images: { type: 'array', items: { type: 'string', format: 'binary' } } } } } } },
      responses: {
        200: { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } } } },
      },
    },
  },
  '/route': {
    post: {
      tags: ['3. Chat'],
      summary: 'Auto-route — classifier picks agy or claude',
      description: 'Only for new apps without a session. Gemini Flash classifies the prompt and picks the best tool.',
      security: [{ ApiKeyHeader: [], AppIdHeader: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } } } },
      responses: {
        200: { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } } } },
      },
    },
  },
  '/models': {
    get: {
      tags: ['4. System'],
      summary: 'List available models',
      parameters: [{ name: 'tool', in: 'query', schema: { type: 'string', enum: ['agy', 'claude'] } }],
      responses: { 200: { description: 'Models list' } },
    },
  },
  '/health': {
    get: {
      tags: ['4. System'],
      summary: 'Health check',
      security: [],
      responses: { 200: { description: 'OK' } },
    },
  },
  '/usage': {
    get: {
      tags: ['4. System'],
      summary: 'Quota usage for Claude and AGY',
      responses: { 200: { description: 'Usage data' } },
    },
  },
};

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'AGY API Docs',
  swaggerOptions: { persistAuthorization: true },
  customCss: `.swagger-ui .topbar { display: none }`,
  customJsStr: `
    window.addEventListener('load', function() {
      var btn = document.createElement('a');
      btn.style = 'position:fixed;top:12px;right:16px;z-index:9999;padding:7px 14px;border-radius:8px;font-size:13px;background:#1e293b;color:#94a3b8;border:1px solid #334155;text-decoration:none';
      btn.href = window.location.origin + '/dashboard';
      btn.target = '_blank';
      btn.textContent = 'Dashboard';
      document.body.appendChild(btn);
    });
  `,
}));
app.get('/docs.json', (req, res) => res.json(swaggerSpec));

// ---------------------------------------------------------------------------
// CLI runners
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
    let stdout = '', stderr = '';

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
    let data = entry, ext = '.jpg';
    const match = entry.match(/^data:(image\/(\w+));base64,(.+)$/);
    if (match) { ext = `.${match[2]}`; data = match[3]; }
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    const filepath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
    return filepath;
  });
}

function cleanupFiles(files) {
  for (const f of files) try { fs.unlinkSync(f); } catch {}
}

const IMAGE_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

function imagesToBase64(paths) {
  return paths.map(fp => {
    const ext = path.extname(fp).slice(1).toLowerCase();
    return { data: fs.readFileSync(fp).toString('base64'), mediaType: IMAGE_MIME[ext] || 'image/jpeg' };
  });
}

function runClaude({ prompt, sessionId, model, effort, images = [], onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const streaming = typeof onChunk === 'function';
    const hasImages = images.length > 0;
    const useStreamJson = streaming || hasImages;

    const args = ['-p', '--dangerously-skip-permissions'];
    if (useStreamJson) args.push('--output-format', 'stream-json', '--verbose');
    else args.push('--output-format', 'json');
    if (hasImages) args.push('--input-format', 'stream-json');
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

    let stdout = '', claudeSessionId = null, collectedResult = null;

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

// ---------------------------------------------------------------------------
// handleChat — core chat logic
// ---------------------------------------------------------------------------

async function handleChat({ res, prompt, conversation_id, model, effort, stream, images = [], tool = 'agy', appId = '' }) {
  const wantStream = stream === true || stream === 'true' || stream === '1';
  const useClaude = tool === 'claude';
  const claudeImages = useClaude && images.length ? imagesToBase64(images) : [];

  if (wantStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendSSE = (data) => {
      if (data.event === 'result') {
        const sid = data.result?.session_id || data.result?.conversation_id;
        if (sid) {
          data.result.session_id = sid;
          data.result.tool_used = tool;
          saveAppSession(appId, sid);
        }
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
    saveAppSession(appId, result.session_id);
    res.json(result);
  }
}

// ---------------------------------------------------------------------------
// POST /chat  &  POST /chat/upload
// ---------------------------------------------------------------------------

async function chatHandler(req, res) {
  const { prompt, model, effort, stream, images_base64, tool } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  let sessionId = null, resolvedTool = tool || 'agy', resolvedModel = model || '';

  if (req.appId) {
    const apps = loadApps();
    const appObj = apps[req.appId];
    sessionId     = appObj.session_id || null;
    resolvedTool  = appObj.tool  || tool  || 'agy';
    resolvedModel = model || appObj.model || '';
  }

  const tempFiles = [];
  try {
    if (Array.isArray(images_base64) && images_base64.length) {
      tempFiles.push(...saveBase64Images(images_base64));
    }
    await handleChat({ res, prompt, conversation_id: sessionId, model: resolvedModel, effort, stream, images: tempFiles, tool: resolvedTool, appId: req.appId });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    cleanupFiles(tempFiles);
  }
}

async function uploadHandler(req, res) {
  const { prompt, model, effort, stream, tool } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  let sessionId = null, resolvedTool = tool || 'agy', resolvedModel = model || '';

  if (req.appId) {
    const apps = loadApps();
    const appObj = apps[req.appId];
    sessionId     = appObj.session_id || null;
    resolvedTool  = appObj.tool  || tool  || 'agy';
    resolvedModel = model || appObj.model || '';
  }

  const uploadedPaths = (req.files || []).map(f => f.path);
  try {
    await handleChat({ res, prompt, conversation_id: sessionId, model: resolvedModel, effort, stream, images: uploadedPaths, tool: resolvedTool, appId: req.appId });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    cleanupFiles(uploadedPaths);
  }
}

app.post('/chat', chatHandler);
app.post('/chat/upload', upload.array('images', 10), uploadHandler);

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.includes('image')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// ---------------------------------------------------------------------------
// POST /route
// ---------------------------------------------------------------------------

async function runRouter(prompt) {
  const routerPrompt = `You are a request router. Reply with ONLY a JSON object, no markdown, no explanation.

Route to "claude" for: writing/debugging/reviewing code, programming, software architecture, APIs, databases, DevOps, file operations.
Route to "agy" for: general questions, creative writing, translation, math, chat, images, general knowledge.

Respond ONLY with: {"tool":"claude"} or {"tool":"agy"}

Request: ${JSON.stringify(prompt.slice(0, 400))}`;

  try {
    const result = await runAgy({ prompt: routerPrompt, model: 'gemini-3.8-flash-low' });
    const text = result.response.trim().replace(/```json\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(text).tool === 'claude' ? 'claude' : 'agy';
  } catch {
    return 'agy';
  }
}

app.post('/route', async (req, res) => {
  const { prompt, model, effort, stream } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  let sessionId = null, resolvedTool = null, resolvedModel = model || '';

  if (req.appId) {
    const apps = loadApps();
    const appObj = apps[req.appId];
    sessionId = appObj.session_id || null;
    // If app already has a session, use its tool. Otherwise auto-route.
    resolvedTool  = sessionId ? (appObj.tool || 'agy') : await runRouter(prompt);
    resolvedModel = model || appObj.model || '';
    // Save chosen tool to app
    if (!appObj.tool) {
      apps[req.appId].tool = resolvedTool;
      saveApps(apps);
    }
  } else {
    resolvedTool = await runRouter(prompt);
  }

  const wantStream = stream === true || stream === 'true' || stream === '1';

  if (wantStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ event: 'route', tool: resolvedTool });
    try {
      const onChunk = (ev) => {
        if (ev.event === 'result') {
          const sid = ev.result?.session_id || ev.result?.conversation_id;
          if (sid) saveAppSession(req.appId, sid);
        }
        send(ev);
      };
      if (resolvedTool === 'claude') {
        await runClaude({ prompt, sessionId, model: resolvedModel, effort, onChunk });
      } else {
        await runAgy({ prompt, conversationId: sessionId, model: resolvedModel, effort, images: [], onChunk });
      }
    } catch (err) { send({ event: 'error', error: err.message }); }
    res.end();
  } else {
    try {
      let result;
      if (resolvedTool === 'claude') {
        result = await runClaude({ prompt, sessionId, model: resolvedModel, effort });
      } else {
        const r = await runAgy({ prompt, conversationId: sessionId, model: resolvedModel, effort, images: [] });
        result = { session_id: r.conversation_id, ...r };
      }
      result.tool_used = resolvedTool;
      saveAppSession(req.appId, result.session_id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

app.get('/apps', (req, res) => {
  const apps = loadApps();
  const items = req.isAdmin
    ? Object.values(apps)
    : Object.values(apps).filter(a => a.owner_user_id === req.userId);
  res.json({ total: items.length, items });
});

app.post('/apps', (req, res) => {
  const { name, tool = 'agy', model = '' } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!['agy', 'claude'].includes(tool)) return res.status(400).json({ error: 'tool must be "agy" or "claude"' });
  const apps = loadApps();
  const app_id = randomUUID();
  apps[app_id] = { app_id, name, owner_user_id: req.userId, session_id: null, tool, model, created_at: new Date().toISOString() };
  saveApps(apps);
  res.status(201).json(apps[app_id]);
});

app.get('/apps/:app_id', appOwnerGuard, (req, res) => {
  res.json(loadApps()[req.params.app_id]);
});

app.delete('/apps/:app_id', appOwnerGuard, (req, res) => {
  const apps = loadApps();
  if (!apps[req.params.app_id]) return res.status(404).json({ error: 'App not found' });
  delete apps[req.params.app_id];
  saveApps(apps);
  res.json({ deleted: true });
});

app.get('/apps/:app_id/messages', appOwnerGuard, (req, res) => {
  const apps = loadApps();
  const appObj = apps[req.params.app_id];
  const sessionId = appObj?.session_id;
  if (!sessionId) return res.json({ messages: [] });

  const tool = appObj.tool || 'agy';

  if (tool === 'claude') {
    const claudeFile = path.join(CLAUDE_PROJECTS_DIR, `${sessionId}.jsonl`);
    if (!fs.existsSync(claudeFile)) return res.json({ messages: [] });
    try {
      const lines = fs.readFileSync(claudeFile, 'utf8').trim().split('\n').filter(Boolean);
      const messages = [];
      for (const line of lines) {
        let d; try { d = JSON.parse(line); } catch { continue; }
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

  // agy session
  const transcriptPath = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(transcriptPath)) return res.json({ messages: [] });
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n').filter(Boolean);
    const messages = [];
    for (const line of lines) {
      let entry; try { entry = JSON.parse(line); } catch { continue; }
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

// ---------------------------------------------------------------------------
// Users (admin)
// ---------------------------------------------------------------------------

app.post('/users', adminOnly, (req, res) => {
  const { name, external_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const users = loadUsers();
  if (external_id) {
    const dup = Object.values(users).find(u => u.external_id === external_id);
    if (dup) return res.status(409).json({ error: 'external_id already exists', user_id: dup.user_id });
  }
  const user_id = randomUUID();
  const api_key = require('crypto').randomBytes(24).toString('hex');
  users[user_id] = { user_id, name, api_key, external_id: external_id || null, created_at: new Date().toISOString() };
  saveUsers(users);
  res.status(201).json(users[user_id]);
});

app.get('/users', adminOnly, (req, res) => {
  const users = loadUsers();
  res.json({ total: Object.keys(users).length, items: Object.values(users) });
});

app.get('/users/me', (req, res) => {
  if (req.isAdmin) return res.json({ user_id: 'admin', name: 'Admin', api_key: null });
  const user = loadUsers()[req.userId];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.delete('/users/:user_id', adminOnly, (req, res) => {
  const users = loadUsers();
  if (!users[req.params.user_id]) return res.status(404).json({ error: 'User not found' });
  delete users[req.params.user_id];
  saveUsers(users);
  const apps = loadApps();
  for (const aid of Object.keys(apps)) {
    if (apps[aid].owner_user_id === req.params.user_id) delete apps[aid];
  }
  saveApps(apps);
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const CLAUDE_MODELS = [
  { id: 'claude-opus-4-8',           name: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-4-6',         name: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
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
      return { id: id.trim(), name: rest.join(' ').trim() };
    });
    if (tool === 'agy') return res.json({ tool: 'agy', models: agyModels });
    res.json({ tools: { agy: { name: 'Antigravity CLI', models: agyModels }, claude: { name: 'Claude Code CLI', models: CLAUDE_MODELS } } });
  });
  proc.on('error', err => res.status(500).json({ error: err.message }));
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({ status: 'ok', agy: AGY_BIN, auth: ADMIN_KEY ? 'enabled' : 'open' });
});

// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3986;
app.listen(PORT, () => {
  console.log(`agy API running on port ${PORT}`);
  console.log(`docs:  http://localhost:${PORT}/docs`);
  console.log(`users: ${Object.keys(loadUsers()).length}, apps: ${Object.keys(loadApps()).length}`);
});
