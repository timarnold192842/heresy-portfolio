// Plaid Investments integration: links brokerage accounts (Fidelity, E*TRADE, ...)
// and returns holdings + investment transactions normalized to the same shape the
// frontend's CSV parsers produce, so they flow through the existing review/apply UI.
//
// The Plaid secret and the per-account access tokens never leave this server.

const crypto = require('crypto');
const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const PLAID_HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com'
};

function getPlaidConfig() {
  const env = (process.env.PLAID_ENV || 'sandbox').trim().toLowerCase();
  const secret = process.env[`PLAID_SECRET_${env.toUpperCase()}`] || process.env.PLAID_SECRET || '';
  return {
    env,
    host: PLAID_HOSTS[env],
    clientId: (process.env.PLAID_CLIENT_ID || '').trim(),
    secret: secret.trim(),
    redirectUri: (process.env.PLAID_REDIRECT_URI || '').trim()
  };
}

function isConfigured(cfg) {
  return Boolean(cfg.host && cfg.clientId && cfg.secret);
}

class PlaidError extends Error {
  constructor(status, body) {
    super((body && (body.error_message || body.display_message)) || `Plaid request failed (${status})`);
    this.httpStatus = status;
    this.code = body && body.error_code;
    this.type = body && body.error_type;
    this.displayMessage = body && body.display_message;
  }
}

async function plaidPost(endpoint, body) {
  const cfg = getPlaidConfig();
  if (!isConfigured(cfg)) throw new PlaidError(500, { error_code: 'NOT_CONFIGURED', error_message: 'Plaid credentials are missing on the server (.env).' });
  const res = await fetch(cfg.host + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId, secret: cfg.secret, ...body })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new PlaidError(res.status, data);
  return data;
}

// ---------- Item (linked login) storage ----------

function createItemStore(filePath) {
  async function readAll() {
    try {
      const doc = JSON.parse(await fs.readFile(filePath, 'utf8'));
      return Array.isArray(doc.items) ? doc.items : [];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }
  async function writeAll(items) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify({ items }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, filePath);
  }
  // Serialize every read-modify-write so concurrent link/unlink/sync can't clobber each other.
  let chain = Promise.resolve();
  function update(fn) {
    const run = chain.then(async () => {
      const items = await readAll();
      const result = await fn(items);
      await writeAll(items);
      return result;
    });
    chain = run.catch(() => {});
    return run;
  }
  return { readAll, update };
}

function publicItem(item) {
  return {
    item_id: item.item_id,
    institution: item.institution,
    institution_id: item.institution_id,
    broker: item.broker,
    env: item.env,
    accounts: item.accounts || [],
    created_at: item.created_at,
    last_synced_at: item.last_synced_at || null,
    needs_reauth: Boolean(item.needs_reauth)
  };
}

// ---------- Normalization ----------

function brokerName(institutionName) {
  const n = String(institutionName || '');
  if (/fidelity/i.test(n)) return 'Fidelity';
  if (/e\s*\*?\s*trade|morgan\s+stanley/i.test(n)) return 'E*TRADE';
  if (/schwab/i.test(n)) return 'Schwab';
  return n || 'Linked account';
}

function accountLabel(acct) {
  if (!acct) return '';
  const name = acct.official_name || acct.name || 'Account';
  return acct.mask ? `${name} …${acct.mask}` : name;
}

const OCC_RE = /^([A-Z.]{1,6})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

// Map a Plaid security to the app's identity fields, or null if it isn't tradable
// (cash, money market, unknown).
function securityIdentity(sec) {
  if (!sec) return null;
  const oc = sec.option_contract;
  if (oc && oc.underlying_security_ticker && oc.expiration_date && oc.strike_price != null) {
    return {
      type: 'option',
      ticker: String(oc.underlying_security_ticker).toUpperCase(),
      expiration: oc.expiration_date,
      strike: Number(oc.strike_price),
      option_type: String(oc.contract_type || '').toLowerCase() === 'put' ? 'P' : 'C'
    };
  }
  const sym = String(sec.ticker_symbol || '').toUpperCase().replace(/^O:/, '');
  const occ = sym.replace(/\s+/g, ' ').match(OCC_RE) || sym.replace(/\s+/g, '').match(OCC_RE);
  if (occ) {
    return {
      type: 'option',
      ticker: occ[1],
      expiration: `20${occ[2]}-${occ[3]}-${occ[4]}`,
      strike: Number(occ[6]) / 1000,
      option_type: occ[5]
    };
  }
  if (sec.is_cash_equivalent || sec.type === 'cash') return null;
  if (!sym || !/^[A-Z][A-Z.]*$/.test(sym)) return null;
  return { type: 'stock', ticker: sym };
}

const near = (a, b) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.02);

// Brokers report option size/price inconsistently (contracts vs. shares, per-share vs.
// per-contract price). Use the reported total to work out which convention applies and
// return { contracts, pricePerShare, convention }. `hint` ('shares' | 'contracts') is the
// convention already observed in this broker's holdings, used when totals are ambiguous.
function normalizeOptionSize(rawQty, rawPrice, total, hint = null) {
  const q = Math.abs(Number(rawQty) || 0);
  const p = Math.abs(Number(rawPrice) || 0);
  const t = Math.abs(Number(total) || 0);
  if (!q) return { contracts: 0, pricePerShare: p, convention: null };
  if (t && p) {
    if (near(q * p * 100, t)) return { contracts: q, pricePerShare: p, convention: 'contracts' };
    if (near(q * p, t)) {
      const shares = hint ? hint === 'shares' : (q >= 100 && q % 100 === 0);
      return shares
        ? { contracts: q / 100, pricePerShare: p, convention: 'shares' }
        : { contracts: q, pricePerShare: p / 100, convention: 'contracts' };
    }
  }
  if (hint === 'shares') return { contracts: q / 100, pricePerShare: p, convention: 'shares' };
  return { contracts: q, pricePerShare: p, convention: null };
}

function normalizeHoldings(resp, broker) {
  const secs = new Map((resp.securities || []).map(s => [s.security_id, s]));
  const accts = new Map((resp.accounts || []).map(a => [a.account_id, a]));
  const out = [];
  out.optionConvention = null;
  for (const h of resp.holdings || []) {
    const id = securityIdentity(secs.get(h.security_id));
    if (!id) continue;
    const rawQty = Number(h.quantity) || 0;
    if (!(rawQty > 0)) continue; // short positions are tracked as cashflow legs, like the CSV import
    const costBasis = h.cost_basis != null ? Math.abs(Number(h.cost_basis)) : NaN;
    let quantity = rawQty;
    let entryPrice = NaN;
    if (id.type === 'option') {
      const n = normalizeOptionSize(rawQty, h.institution_price, h.institution_value);
      quantity = n.contracts;
      if (n.convention && !out.optionConvention) out.optionConvention = n.convention;
      if (isFinite(costBasis) && quantity) entryPrice = costBasis / (quantity * 100);
    } else if (isFinite(costBasis) && quantity) {
      entryPrice = costBasis / quantity;
    }
    out.push({
      source: broker,
      account: accountLabel(accts.get(h.account_id)),
      ...id,
      quantity,
      entryPrice,
      costBasis
    });
  }
  return out;
}

function transactionAction(tx, id, sellShortIdentities, idKey) {
  const type = String(tx.type || '').toLowerCase();
  const sub = String(tx.subtype || '').toLowerCase();
  if (sub === 'sell short') return 'cashflow_open';
  if (sub === 'buy to cover') return 'cashflow_close';
  // Option legs that end via expiry/assignment/exercise. Stock legs of those events
  // (e.g. shares received from an assigned put) fall through to buy/sell below.
  if (id.type === 'option' && (sub === 'expire' || sub === 'assignment' || sub === 'exercise')) {
    return sellShortIdentities.has(idKey) ? 'cashflow_close' : 'close';
  }
  if (type === 'buy') return 'open';
  if (type === 'sell') return 'close';
  if (type === 'transfer' && id.type === 'stock') {
    const q = Number(tx.quantity) || 0;
    if (q > 0) return 'open';
    if (q < 0) return 'close';
  }
  return null;
}

function identityKey(id) {
  return id.type === 'option' ? `${id.ticker}|${id.expiration}|${id.strike}|${id.option_type}` : id.ticker;
}

function normalizeTransactions(transactions, securities, accounts, broker, optionConvention = null) {
  const secs = new Map((securities || []).map(s => [s.security_id, s]));
  const accts = new Map((accounts || []).map(a => [a.account_id, a]));
  const rows = [];
  for (const tx of transactions) {
    const id = securityIdentity(secs.get(tx.security_id));
    if (id) rows.push({ tx, id, key: identityKey(id) });
  }
  const sellShort = new Set(rows.filter(r => String(r.tx.subtype || '').toLowerCase() === 'sell short').map(r => r.key));
  const out = [];
  for (const { tx, id, key } of rows) {
    const action = transactionAction(tx, id, sellShort, key);
    if (!action) continue;
    const sub = String(tx.subtype || '').toLowerCase();
    let quantity = Math.abs(Number(tx.quantity) || 0);
    let price = Math.abs(Number(tx.price) || 0);
    if (id.type === 'option') {
      const gross = Math.abs(Number(tx.amount) || 0) - Math.abs(Number(tx.fees) || 0) * Math.sign(Number(tx.amount) || 0);
      const n = normalizeOptionSize(quantity, price, Math.abs(gross), optionConvention);
      quantity = n.contracts;
      price = n.pricePerShare;
    }
    if (sub === 'expire' && id.type === 'option') price = 0;
    out.push({
      source: broker,
      account: accountLabel(accts.get(tx.account_id)),
      date: tx.date,
      action,
      ...id,
      quantity,
      price,
      plaidSubtype: sub || String(tx.type || '')
    });
  }
  return out;
}

// ---------- Auth ----------

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(hostHeader) {
  try { return new URL(`http://${hostHeader}`).hostname; } catch (_e) { return ''; }
}

// Direct request from this machine *and* addressed to a local hostname. Checking Host and
// Origin defeats DNS-rebinding pages that resolve their own domain to 127.0.0.1.
function isDirectLoopback(req) {
  const addr = (req.socket && req.socket.remoteAddress) || '';
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (!loopback || req.headers['x-forwarded-for']) return false;
  if (!LOCAL_HOSTNAMES.has(hostnameOf(req.headers.host || ''))) return false;
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let originHost = '';
    try { originHost = new URL(origin).hostname; } catch (_e) { return false; }
    if (!LOCAL_HOSTNAMES.has(originHost)) return false;
  }
  return true;
}

// Account data is sensitive: require the write token, or (when no token is configured)
// only allow requests made directly from this machine. Fails closed behind a proxy.
function requireOwner(writeToken) {
  return (req, res, next) => {
    // JSON-only POSTs force a CORS preflight, so other sites can't fire simple form posts.
    if (req.method === 'POST' && !req.is('application/json')) {
      return res.status(415).json({ error: 'json_required', message: 'Requests must be JSON.' });
    }
    if (writeToken) {
      if (safeEqual(req.header('x-write-token'), writeToken)) return next();
      return res.status(401).json({ error: 'unauthorized', message: 'Missing or wrong write token.' });
    }
    if (isDirectLoopback(req)) return next();
    return res.status(403).json({ error: 'token_required', message: 'Set APP_WRITE_TOKEN on the server to use account linking from another device.' });
  };
}

// ---------- Router ----------

function sendPlaidError(res, err) {
  const status = err.code === 'NOT_CONFIGURED' ? 503 : (err.httpStatus && err.httpStatus < 500 ? 400 : 502);
  if (!(err instanceof PlaidError)) console.error('Plaid route error:', err);
  res.status(status).json({ error: err.code || 'plaid_error', message: err.displayMessage || err.message });
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function createPlaidRouter({ itemsFile, writeToken }) {
  const router = express.Router();
  const store = createItemStore(itemsFile);
  router.use(requireOwner(writeToken));

  router.get('/status', async (_req, res) => {
    try {
      const cfg = getPlaidConfig();
      const items = (await store.readAll()).filter(i => i.env === cfg.env);
      res.json({ configured: isConfigured(cfg), env: cfg.env, oauthRedirect: Boolean(cfg.redirectUri), items: items.map(publicItem) });
    } catch (err) {
      sendPlaidError(res, err);
    }
  });

  router.post('/link-token', async (req, res) => {
    try {
      const cfg = getPlaidConfig();
      const body = {
        client_name: 'Heresy Portfolio',
        user: { client_user_id: 'heresy-portfolio-owner' },
        country_codes: ['US'],
        language: 'en'
      };
      if (cfg.redirectUri) body.redirect_uri = cfg.redirectUri;
      const itemId = req.body && req.body.item_id;
      if (itemId) {
        // Update mode: re-authenticate an existing login without creating a new Item.
        const item = (await store.readAll()).find(i => i.item_id === itemId);
        if (!item) return res.status(404).json({ error: 'item_not_found', message: 'That linked account no longer exists.' });
        body.access_token = item.access_token;
      } else {
        body.products = ['investments'];
      }
      const data = await plaidPost('/link/token/create', body);
      res.json({ link_token: data.link_token, expiration: data.expiration });
    } catch (err) {
      sendPlaidError(res, err);
    }
  });

  router.post('/exchange', async (req, res) => {
    try {
      const { public_token: publicToken, institution } = req.body || {};
      if (!publicToken) return res.status(400).json({ error: 'missing_public_token', message: 'No public token supplied.' });
      const cfg = getPlaidConfig();
      const ex = await plaidPost('/item/public_token/exchange', { public_token: publicToken });
      let accounts = [];
      try {
        const acc = await plaidPost('/accounts/get', { access_token: ex.access_token });
        const all = acc.accounts || [];
        const investment = all.filter(a => a.type === 'investment');
        accounts = (investment.length ? investment : all).map(a => ({ name: accountLabel(a), type: a.type, subtype: a.subtype }));
      } catch (_err) { /* accounts are display-only */ }
      const instName = (institution && institution.name) || 'Linked account';
      const instId = (institution && institution.institution_id) || null;
      const item = {
        item_id: ex.item_id,
        access_token: ex.access_token,
        institution: instName,
        institution_id: instId,
        broker: brokerName(instName),
        env: cfg.env,
        accounts,
        created_at: new Date().toISOString()
      };
      const duplicate = await store.update(items => {
        const dup = items.find(i => i.env === cfg.env && instId && i.institution_id === instId);
        items.push(item);
        return dup;
      });
      res.json({ item: publicItem(item), duplicate_of: duplicate ? duplicate.item_id : null });
    } catch (err) {
      sendPlaidError(res, err);
    }
  });

  router.delete('/items/:itemId', async (req, res) => {
    try {
      const items = await store.readAll();
      const item = items.find(i => i.item_id === req.params.itemId);
      if (!item) return res.status(404).json({ error: 'item_not_found', message: 'That linked account no longer exists.' });
      try {
        await plaidPost('/item/remove', { access_token: item.access_token });
      } catch (err) {
        // Still forget it locally if Plaid already considers it gone.
        if (err.code !== 'ITEM_NOT_FOUND' && err.code !== 'INVALID_ACCESS_TOKEN') throw err;
      }
      await store.update(current => {
        const idx = current.findIndex(i => i.item_id === item.item_id);
        if (idx >= 0) current.splice(idx, 1);
      });
      res.json({ ok: true });
    } catch (err) {
      sendPlaidError(res, err);
    }
  });

  router.post('/sync', async (req, res) => {
    try {
      const cfg = getPlaidConfig();
      const refresh = Boolean(req.body && req.body.refresh);
      const days = Math.min(730, Math.max(1, Number(req.body && req.body.days) || 730));
      const end = new Date();
      const start = new Date(end.getTime() - days * 86400000);
      const items = await store.readAll();
      const active = items.filter(i => i.env === cfg.env);
      const results = [];
      const holdings = [];
      const transactions = [];

      for (const item of active) {
        const r = { item_id: item.item_id, institution: item.institution, broker: item.broker, ok: false, holdings: 0, transactions: 0, refreshed: false, error: null, needs_reauth: false };
        try {
          if (refresh) {
            try {
              await plaidPost('/investments/refresh', { access_token: item.access_token });
              r.refreshed = true;
              await sleep(4000); // refresh is asynchronous; give the broker a moment
            } catch (err) {
              r.refresh_error = err.displayMessage || err.message;
            }
          }
          const h = await plaidPost('/investments/holdings/get', { access_token: item.access_token });
          const itemHoldings = normalizeHoldings(h, item.broker);

          const allTx = [];
          const securities = [...(h.securities || [])];
          const accounts = [...(h.accounts || [])];
          let offset = 0;
          let total = Infinity;
          while (offset < total) {
            const t = await plaidPost('/investments/transactions/get', {
              access_token: item.access_token,
              start_date: isoDate(start),
              end_date: isoDate(end),
              options: { count: 500, offset }
            });
            total = t.total_investment_transactions || 0;
            securities.push(...(t.securities || []));
            accounts.push(...(t.accounts || []));
            const batch = t.investment_transactions || [];
            allTx.push(...batch);
            if (!batch.length) break;
            offset += batch.length;
          }
          const itemTx = normalizeTransactions(allTx, securities, accounts, item.broker, itemHoldings.optionConvention);

          holdings.push(...itemHoldings);
          transactions.push(...itemTx);
          r.ok = true;
          r.holdings = itemHoldings.length;
          r.transactions = itemTx.length;
          r.synced_at = new Date().toISOString();
        } catch (err) {
          r.error = err.code === 'PRODUCT_NOT_READY'
            ? 'Plaid is still pulling data from this account. Try again in a minute or two.'
            : (err.displayMessage || err.message);
          r.error_code = err.code || null;
          if (['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT'].includes(err.code)) {
            r.needs_reauth = true;
          }
          if (!(err instanceof PlaidError)) console.error('Plaid sync error:', err);
        }
        results.push(r);
      }
      // Re-read under the lock and touch only sync metadata, so links/unlinks made
      // while this sync was running are preserved.
      await store.update(current => {
        for (const r of results) {
          const it = current.find(i => i.item_id === r.item_id);
          if (!it) continue;
          if (r.ok) { it.last_synced_at = r.synced_at; it.needs_reauth = false; }
          if (r.needs_reauth) it.needs_reauth = true;
        }
      });
      res.json({ env: cfg.env, items: results, holdings, transactions });
    } catch (err) {
      sendPlaidError(res, err);
    }
  });

  return router;
}

module.exports = {
  createPlaidRouter,
  getPlaidConfig,
  isConfigured,
  // exported for tests
  _internal: { securityIdentity, normalizeOptionSize, normalizeHoldings, normalizeTransactions, brokerName, plaidPost }
};
