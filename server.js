const path = require('path');

// Load secrets from .env when present (Node >= 20.12); hosted deployments use real env vars.
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.join(__dirname, '.env'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not read .env:', err.message);
  }
}

const express = require('express');
const fs = require('fs/promises');
const { createPlaidRouter, getPlaidConfig, isConfigured } = require('./plaid');

const app = express();
const port = process.env.PORT || 3000;
const statePath = process.env.STATE_FILE || path.join(__dirname, 'data', 'state.json');
const plaidItemsPath = process.env.PLAID_ITEMS_FILE || path.join(path.dirname(statePath), 'plaid-items.json');
const writeToken = process.env.APP_WRITE_TOKEN || '';
// Comma-separated origins allowed to call the API cross-origin (e.g. the GitHub Pages site).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-write-token');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/plaid', createPlaidRouter({ itemsFile: plaidItemsPath, writeToken }));

async function readStateFile() {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { state: null, updatedAt: null };
    }
    throw err;
  }
}

async function writeStateFile(doc) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, statePath);
}

function isAuthorized(req) {
  if (!writeToken) return true;
  const token = req.header('x-write-token') || '';
  return token === writeToken;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.get('/api/state', async (_req, res) => {
  try {
    const doc = await readStateFile();
    res.json(doc);
  } catch (err) {
    console.error('Failed to read state:', err);
    res.status(500).json({ error: 'failed_to_read_state' });
  }
});

app.put('/api/state', async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const { state } = req.body || {};
  if (!state || typeof state !== 'object' || !Array.isArray(state.trades)) {
    res.status(400).json({ error: 'invalid_state_payload' });
    return;
  }

  const doc = {
    state,
    updatedAt: new Date().toISOString()
  };

  try {
    await writeStateFile(doc);
    res.json({ ok: true, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error('Failed to write state:', err);
    res.status(500).json({ error: 'failed_to_write_state' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'heresy.html'));
});

app.listen(port, () => {
  console.log(`Heresy portfolio server running on http://localhost:${port}`);
  console.log(`State file: ${statePath}`);
  if (writeToken) {
    console.log('Write token protection is enabled');
  }
  const plaid = getPlaidConfig();
  console.log(isConfigured(plaid) ? `Plaid: ${plaid.env} (linked accounts stored in ${plaidItemsPath})` : 'Plaid: not configured (set PLAID_CLIENT_ID and PLAID_SECRET_<ENV>)');
});
