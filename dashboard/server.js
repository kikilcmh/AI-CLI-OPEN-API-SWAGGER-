'use strict';
const express = require('express');
const http = require('http');
const { URL } = require('url');
const path = require('path');

const app = express();

const API_URL = process.env.API_URL || 'http://agy-api:3986';
const API_KEY = process.env.API_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PORT = process.env.PORT || 3000;

// Config endpoint — browser reads this to know API_URL and API_KEY
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.AGY_CONFIG = ${JSON.stringify({ apiKey: API_KEY, adminKey: ADMIN_KEY })};`);
});

// Proxy /api/* → actual API (inject API key, pipe streams)
app.use('/api', (req, res) => {
  const target = new URL(API_URL);
  const options = {
    hostname: target.hostname,
    port: parseInt(target.port, 10) || 3986,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      'x-api-key': API_KEY,
      host: target.host,
    },
  };

  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxy.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: 'API unavailable', message: err.message });
    }
  });

  req.pipe(proxy, { end: true });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`AGY Dashboard on http://0.0.0.0:${PORT}`));
