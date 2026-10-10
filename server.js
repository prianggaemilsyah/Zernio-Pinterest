const express = require('express');
const fetch = require('node-fetch');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { registerStoreRoutes, classifyAccountIssue } = require('./store');

function createApp(apiKeyPath, storePath) {
  const app = express();
  const uploadDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({ dest: uploadDir });
  const STORE_PATH = storePath || path.join(__dirname, 'data', 'store.json');

  const ZERNIO_BASE = 'https://zernio.com/api/v1';
  let ALL_KEYS = [];
  try {
    ALL_KEYS = fs.readFileSync(apiKeyPath, 'utf8').trim().split('\n').map(k => k.trim()).filter(Boolean);
  } catch { ALL_KEYS = []; }

  let activeKeyIndex = 0;

  function saveKeys() {
    try { fs.writeFileSync(apiKeyPath, ALL_KEYS.join('\n'), 'utf8'); } catch {}
  }

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  function getActiveKey(idx) {
    if (idx !== undefined && idx >= 0 && idx < ALL_KEYS.length) return ALL_KEYS[idx];
    return ALL_KEYS[activeKeyIndex] || ALL_KEYS[0];
  }
  function zernioHeaders(extra = {}, keyIdx) {
    return { 'Authorization': `Bearer ${getActiveKey(keyIdx)}`, ...extra };
  }

  async function safeJsonParse(response) {
    const text = await response.text();
    try { return JSON.parse(text); }
    catch { return { error: `Non-JSON response (HTTP ${response.status})`, raw: text.substring(0, 200) }; }
  }

  async function zernioGet(endpoint, params = {}, keyIdx) {
    const url = new URL(`${ZERNIO_BASE}${endpoint}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    });
    const res = await fetch(url.toString(), { headers: zernioHeaders({}, keyIdx) });
    return safeJsonParse(res);
  }

  async function zernioPost(endpoint, body = {}, keyIdx) {
    const res = await fetch(`${ZERNIO_BASE}${endpoint}`, {
      method: 'POST',
      headers: zernioHeaders({ 'Content-Type': 'application/json' }, keyIdx),
      body: JSON.stringify(body)
    });
    return safeJsonParse(res);
  }

  async function zernioPut(endpoint, body = {}, keyIdx) {
    const res = await fetch(`${ZERNIO_BASE}${endpoint}`, {
      method: 'PUT',
      headers: zernioHeaders({ 'Content-Type': 'application/json' }, keyIdx),
      body: JSON.stringify(body)
    });
    return safeJsonParse(res);
  }

  async function zernioDelete(endpoint, keyIdx) {
    const res = await fetch(`${ZERNIO_BASE}${endpoint}`, {
      method: 'DELETE',
      headers: zernioHeaders({}, keyIdx)
    });
    return safeJsonParse(res);
  }

  // Download a remote image and re-host it on Zernio storage, returning a
  // public URL that Pinterest will accept (it rejects hot-linked marketplace URLs).
  async function hostImage(imageUrl, keyIdx) {
    const dl = await fetch(imageUrl);
    if (!dl.ok) throw new Error('unduh gambar gagal (HTTP ' + dl.status + ')');
    const buf = await dl.buffer();
    const ct = dl.headers.get('content-type') || 'image/jpeg';
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'jpg';
    const pre = await zernioPost('/media/presign', { filename: 'pin_' + Date.now() + '.' + ext, contentType: ct, size: buf.length }, keyIdx);
    if (!pre || pre.error || !pre.uploadUrl || !pre.publicUrl) {
      const msg = pre && pre.error ? (typeof pre.error === 'string' ? pre.error : JSON.stringify(pre.error)) : 'respon tidak valid';
      const err = new Error('presign gagal: ' + msg);
      if (pre && pre.code) err.code = pre.code;
      if (pre && pre.billingUrl) err.billingUrl = pre.billingUrl;
      throw err;
    }
    const put = await fetch(pre.uploadUrl, { method: 'PUT', headers: { 'Content-Type': ct }, body: buf });
    if (!put.ok) throw new Error('unggah ke storage gagal (HTTP ' + put.status + ')');
    return pre.publicUrl;
  }

  // Build a display entry for one key from its pinterest account + boards
  async function describeKey(key, i) {
    const entry = { index: i, keyPreview: key.slice(0, 8) + '...' + key.slice(-4), isActive: i === activeKeyIndex, pageName: null, pageIcon: null, boardCount: 0, boardNames: [], connected: false };
    try {
      const data = await zernioGet('/accounts', { platform: 'pinterest' }, i);
      const accounts = data.accounts || [];
      if (accounts.length) {
        const a = accounts[0];
        entry.pageName = a.displayName || a.username || null;
        entry.pageIcon = a.profilePicture || null;
        entry.pageUrl = a.profileUrl || null;
        entry.connected = a.isActive !== false;
        try {
          const bd = await zernioGet(`/accounts/${a._id}/pinterest-boards`, {}, i);
          if (Array.isArray(bd.boards)) {
            entry.boardCount = bd.boards.length;
            entry.boardNames = bd.boards.slice(0, 5).map(b => b.name);
          }
        } catch {}
      }
    } catch {}
    if (!entry.pageName) entry.pageName = `Pinterest ${i + 1}`;
    return entry;
  }

  // ========== KEY MANAGEMENT ==========

  app.get('/api/keys', async (req, res) => {
    const result = await Promise.all(ALL_KEYS.map((key, i) => describeKey(key, i)));
    res.json({ keys: result, activeIndex: activeKeyIndex, total: ALL_KEYS.length });
  });

  app.post('/api/keys', async (req, res) => {
    const { key } = req.body;
    if (!key || typeof key !== 'string' || !key.trim()) {
      return res.status(400).json({ error: 'API key tidak valid' });
    }
    const trimmed = key.trim();
    if (ALL_KEYS.includes(trimmed)) {
      return res.status(400).json({ error: 'API key sudah ada' });
    }
    try {
      const testRes = await fetch(`${ZERNIO_BASE}/accounts`, {
        headers: { 'Authorization': `Bearer ${trimmed}` }
      });
      const testData = await safeJsonParse(testRes);
      if (testData.error && !testData.accounts) {
        return res.status(400).json({ error: 'API key tidak valid atau tidak aktif' });
      }
    } catch (e) {
      return res.status(400).json({ error: 'Gagal validasi key: ' + e.message });
    }
    ALL_KEYS.push(trimmed);
    saveKeys();
    res.json({ success: true, total: ALL_KEYS.length });
  });

  app.delete('/api/keys/:index', (req, res) => {
    const idx = parseInt(req.params.index);
    if (isNaN(idx) || idx < 0 || idx >= ALL_KEYS.length) {
      return res.status(400).json({ error: 'Index tidak valid' });
    }
    ALL_KEYS.splice(idx, 1);
    if (ALL_KEYS.length === 0) activeKeyIndex = 0;
    else if (activeKeyIndex >= ALL_KEYS.length) activeKeyIndex = ALL_KEYS.length - 1;
    else if (idx < activeKeyIndex) activeKeyIndex--;
    else if (idx === activeKeyIndex) activeKeyIndex = Math.min(activeKeyIndex, ALL_KEYS.length - 1);
    saveKeys();
    res.json({ success: true, activeIndex: activeKeyIndex, total: ALL_KEYS.length });
  });

  // ========== PAGES / PROFILES (multi-key) ==========

  app.get('/api/pages', async (req, res) => {
    const pages = await Promise.all(ALL_KEYS.map((key, i) => describeKey(key, i)));
    res.json({ pages, activeIndex: activeKeyIndex, totalKeys: ALL_KEYS.length });
  });

  app.post('/api/switch-page', (req, res) => {
    const { index } = req.body;
    if (index === undefined || index < 0 || index >= ALL_KEYS.length) return res.status(400).json({ error: 'Invalid index' });
    activeKeyIndex = index;
    res.json({ success: true, activeIndex: activeKeyIndex });
  });

  // ========== ACCOUNTS ==========

  app.get('/api/accounts', async (req, res) => {
    try { res.json(await zernioGet('/accounts', { platform: 'pinterest', profileId: req.query.profileId })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ========== BOARDS ==========

  app.get('/api/accounts/:id/pinterest-boards', async (req, res) => {
    try { res.json(await zernioGet(`/accounts/${req.params.id}/pinterest-boards`)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/accounts/:id/pinterest-boards', async (req, res) => {
    try { res.json(await zernioPost(`/accounts/${req.params.id}/pinterest-boards`, req.body)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/accounts/:id/pinterest-boards', async (req, res) => {
    try { res.json(await zernioPut(`/accounts/${req.params.id}/pinterest-boards`, req.body)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ========== POSTS (PINS) ==========

  app.get('/api/posts', async (req, res) => {
    try {
      res.json(await zernioGet('/posts', {
        profileId: req.query.profileId, platform: req.query.platform || 'pinterest',
        source: req.query.source || 'zernio', accountId: req.query.accountId,
        page: req.query.page || 1, limit: req.query.limit || 20
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/posts', async (req, res) => {
    try { res.json(await zernioPost('/posts', req.body)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/posts/:id', async (req, res) => {
    try { res.json(await zernioDelete(`/posts/${req.params.id}`)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ========== MEDIA ==========

  app.post('/api/media/presign', async (req, res) => {
    try { res.json(await zernioPost('/media/presign', req.body)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/media/upload-direct', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const FormData = require('form-data');
      const formData = new FormData();
      formData.append('file', fs.createReadStream(req.file.path), req.file.originalname);
      const data = await zernioPost('/media/upload-direct', null);
      fs.unlinkSync(req.file.path);
      res.json(data);
    } catch (e) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(500).json({ error: e.message });
    }
  });

  // ========== ANALYTICS ==========

  app.get('/api/analytics', async (req, res) => {
    try {
      res.json(await zernioGet('/analytics', {
        platform: req.query.platform || 'pinterest', accountId: req.query.accountId,
        profileId: req.query.profileId, source: req.query.source,
        fromDate: req.query.fromDate, toDate: req.query.toDate,
        limit: req.query.limit, page: req.query.page,
        sortBy: req.query.sortBy, order: req.query.order
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/analytics/daily-metrics', async (req, res) => {
    try {
      res.json(await zernioGet('/analytics/daily-metrics', {
        platform: req.query.platform || 'pinterest', accountId: req.query.accountId,
        profileId: req.query.profileId, fromDate: req.query.fromDate, toDate: req.query.toDate,
        source: req.query.source, attribution: req.query.attribution
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/analytics/best-time', async (req, res) => {
    try {
      res.json(await zernioGet('/analytics/best-time', {
        platform: req.query.platform || 'pinterest', accountId: req.query.accountId,
        profileId: req.query.profileId, source: req.query.source
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/accounts/follower-stats', async (req, res) => {
    try {
      res.json(await zernioGet('/accounts/follower-stats', {
        accountIds: req.query.accountIds, fromDate: req.query.fromDate,
        toDate: req.query.toDate, granularity: req.query.granularity || 'daily'
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ========== PROFILES ==========

  app.get('/api/profiles', async (req, res) => {
    try { res.json(await zernioGet('/profiles')); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ========== USER ==========

  app.get('/api/user', async (req, res) => {
    try { res.json(await zernioGet('/user')); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ========== ACCOUNT HEALTH ==========
  // Lightweight probe that surfaces account-level problems (billing/suspension)
  // so the UI can warn the user with the real reason instead of silent failures.
  app.get('/api/account-status', async (req, res) => {
    try {
      const d = await zernioGet('/posts', { platform: 'pinterest', limit: 1 });
      const issue = classifyAccountIssue(d);
      if (issue) return res.json({ ok: false, accountIssue: true, ...issue });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ========== MASS UPLOAD / DRAFTS / SCHEDULES ==========
  registerStoreRoutes(app, { storePath: STORE_PATH, zernioPost, hostImage });

  return app;
}

if (require.main === module) {
  const PORT = 3100;
  const apiKeyPath = process.argv[2] || path.join(__dirname, '..', 'API_Zernio_Pinterest');
  const app = createApp(apiKeyPath);
  app.listen(PORT, () => {
    console.log(`Pinterest Dashboard running at http://localhost:${PORT}`);
  });
}

module.exports = { createApp };
