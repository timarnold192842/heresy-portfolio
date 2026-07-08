const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const statePath = process.env.STATE_FILE || path.join(__dirname, 'data', 'state.json');
const writeToken = process.env.APP_WRITE_TOKEN || '';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
});
