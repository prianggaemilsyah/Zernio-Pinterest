const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const express = require('express');
const fetch = require('node-fetch');
const multer = require('multer');
const cors = require('cors');
const FormData = require('form-data');
const { registerStoreRoutes, classifyAccountIssue } = require('./store');

const { execSync } = require('child_process');

let mainWindow;
let server;
const PORT = 3100;

function killPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
      const lines = out.trim().split('\n');
      const pids = new Set();
      lines.forEach(l => {
        const m = l.trim().match(/\s+(\d+)\s*$/);
        if (m) pids.add(m[1]);
      });
      pids.forEach(pid => {
        try { execSync(`taskkill /PID ${pid} /F`, { encoding: 'utf8' }); } catch {}
      });
    }
  } catch {}
}

// ========== API KEY MANAGEMENT ==========
const KEYS_FILE_DEV = path.join(__dirname, '..', 'API_Zernio_Pinterest');

function getKeysFilePath() {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'API_Zernio_Pinterest');
  }
  return KEYS_FILE_DEV;
}

let ALL_KEYS = [];

function loadKeys() {
  const fp = getKeysFilePath();
  try {
    ALL_KEYS = fs.readFileSync(fp, 'utf8').trim().split('\n').map(k => k.trim()).filter(Boolean);
  } catch {
    ALL_KEYS = [];
  }
}

function saveKeys() {
  const fp = getKeysFilePath();
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, ALL_KEYS.join('\n'), 'utf8');
}

function initKeysFile() {
  if (app.isPackaged) {
    const fp = getKeysFilePath();
    if (!fs.existsSync(fp)) {
      const src = path.join(process.resourcesPath, 'API_Zernio_Pinterest');
      try {
        const data = fs.readFileSync(src, 'utf8');
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, data, 'utf8');
      } catch {}
    }
  }
  loadKeys();
}

let activeKeyIndex = 0;

function getActiveKey(idx) {
  if (idx !== undefined && idx >= 0 && idx < ALL_KEYS.length) return ALL_KEYS[idx];
  return ALL_KEYS[activeKeyIndex] || ALL_KEYS[0];
}

// ========== ZERNIO API HELPERS ==========
function zernioHeaders(extra = {}, keyIdx) {
  return { 'Authorization': `Bearer ${getActiveKey(keyIdx)}`, ...extra };
}

async function safeJsonParse(response) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { return { error: `Non-JSON response (HTTP ${response.status})`, raw: text.substring(0, 200) }; }
}

async function zernioGet(endpoint, params = {}, keyIdx) {
  const url = new URL(`https://zernio.com/api/v1${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), { headers: zernioHeaders({}, keyIdx) });
  return safeJsonParse(res);
}

async function zernioPost(endpoint, body = {}, keyIdx) {
  const res = await fetch(`https://zernio.com/api/v1${endpoint}`, {
    method: 'POST',
    headers: zernioHeaders({ 'Content-Type': 'application/json' }, keyIdx),
    body: JSON.stringify(body)
  });
  return safeJsonParse(res);
}

async function zernioPut(endpoint, body = {}, keyIdx) {
  const res = await fetch(`https://zernio.com/api/v1${endpoint}`, {
    method: 'PUT',
    headers: zernioHeaders({ 'Content-Type': 'application/json' }, keyIdx),
    body: JSON.stringify(body)
  });
  return safeJsonParse(res);
}

async function zernioDelete(endpoint, keyIdx) {
  const res = await fetch(`https://zernio.com/api/v1${endpoint}`, {
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

// ========== EXPRESS SERVER ==========
function startServer() {
  const expressApp = express();
  const uploadDir = path.join(app.getPath('userData'), 'uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({ dest: uploadDir });

  expressApp.use(cors());
  expressApp.use(express.json({ limit: '50mb' }));
  expressApp.use(express.urlencoded({ extended: true, limit: '50mb' }));
  expressApp.use(express.static(path.join(__dirname, 'public')));

  // ========== KEY MANAGEMENT ==========

  expressApp.get('/api/keys', async (req, res) => {
    const result = await Promise.all(ALL_KEYS.map((key, i) => describeKey(key, i)));
    res.json({ keys: result, activeIndex: activeKeyIndex, total: ALL_KEYS.length });
  });

  expressApp.post('/api/keys', async (req, res) => {
    const { key } = req.body;
    if (!key || typeof key !== 'string' || !key.trim()) {
      return res.status(400).json({ error: 'API key tidak valid' });
    }
    const trimmed = key.trim();
    if (ALL_KEYS.includes(trimmed)) {
      return res.status(400).json({ error: 'API key sudah ada' });
    }
    try {
      const testRes = await fetch('https://zernio.com/api/v1/accounts', {
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

  expressApp.delete('/api/keys/:index', (req, res) => {
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

  // ========== PAGES / PROFILES ==========

  expressApp.get('/api/pages', async (req, res) => {
    const pages = await Promise.all(ALL_KEYS.map((key, i) => describeKey(key, i)));
    res.json({ pages, activeIndex: activeKeyIndex, totalKeys: ALL_KEYS.length });
  });

  expressApp.post('/api/switch-page', (req, res) => {
    const { index } = req.body;
    if (index === undefined || index < 0 || index >= ALL_KEYS.length) return res.status(400).json({ error: 'Invalid index' });
    activeKeyIndex = index;
    res.json({ success: true, activeIndex: activeKeyIndex });
  });

  // ========== ACCOUNTS ==========

  expressApp.get('/api/accounts', async (req, res) => {
    try { res.json(await zernioGet('/accounts', { platform: 'pinterest', profileId: req.query.profileId })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ========== BOARDS ==========

  expressApp.get('/api/accounts/:id/pinterest-boards', async (req, res) => {
    try { res.json(await zernioGet(`/accounts/${req.params.id}/pinterest-boards`)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  expressApp.post('/api/accounts/:id/pinterest-boards', async (req, res) => {
    try { res.json(await zernioPost(`/accounts/${req.params.id}/pinterest-boards`, req.body)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  expressApp.put('/api/accounts/:id/pinterest-boards', async (req, res) => {
    try { res.json(await zernioPut(`/accounts/${req.params.id}/pinterest-boards`, req.body)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ========== POSTS (PINS) ==========

  expressApp.get('/api/posts', async (req, res) => {
    try {
      res.json(await zernioGet('/posts', {
        profileId: req.query.profileId, platform: req.query.platform || 'pinterest',
        source: req.query.source || 'zernio', accountId: req.query.accountId,
        page: req.query.page || 1, limit: req.query.limit || 20
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  expressApp.post('/api/posts', async (req, res) => {
    try { res.json(await zernioPost('/posts', req.body)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  expressApp.delete('/api/posts/:id', async (req, res) => {
    try { res.json(await zernioDelete(`/posts/${req.params.id}`)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ========== MEDIA ==========

  expressApp.post('/api/media/presign', async (req, res) => {
    try { res.json(await zernioPost('/media/presign', req.body)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  expressApp.post('/api/media/upload-direct', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const formData = new FormData();
      formData.append('file', fs.createReadStream(req.file.path), req.file.originalname);
      const upRes = await fetch('https://zernio.com/api/v1/media/upload-direct', {
        method: 'POST',
        headers: zernioHeaders(formData.getHeaders()),
        body: formData
      });
      const data = await safeJsonParse(upRes);
      fs.unlinkSync(req.file.path);
      res.json(data);
    } catch (e) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(500).json({ error: e.message });
    }
  });

  // ========== ANALYTICS ==========

  expressApp.get('/api/analytics', async (req, res) => {
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

  expressApp.get('/api/analytics/daily-metrics', async (req, res) => {
    try {
      res.json(await zernioGet('/analytics/daily-metrics', {
        platform: req.query.platform || 'pinterest', accountId: req.query.accountId,
        profileId: req.query.profileId, fromDate: req.query.fromDate, toDate: req.query.toDate,
        source: req.query.source, attribution: req.query.attribution
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  expressApp.get('/api/analytics/best-time', async (req, res) => {
    try {
      res.json(await zernioGet('/analytics/best-time', {
        platform: req.query.platform || 'pinterest', accountId: req.query.accountId,
        profileId: req.query.profileId, source: req.query.source
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  expressApp.get('/api/accounts/follower-stats', async (req, res) => {
    try {
      res.json(await zernioGet('/accounts/follower-stats', {
        accountIds: req.query.accountIds, fromDate: req.query.fromDate,
        toDate: req.query.toDate, granularity: req.query.granularity || 'daily'
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ========== PROFILES ==========

  expressApp.get('/api/profiles', async (req, res) => {
    try { res.json(await zernioGet('/profiles')); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ========== USER ==========

  expressApp.get('/api/user', async (req, res) => {
    try { res.json(await zernioGet('/user')); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ========== ACCOUNT HEALTH ==========
  expressApp.get('/api/account-status', async (req, res) => {
    try {
      const d = await zernioGet('/posts', { platform: 'pinterest', limit: 1 });
      const issue = classifyAccountIssue(d);
      if (issue) return res.json({ ok: false, accountIssue: true, ...issue });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ========== MASS UPLOAD / DRAFTS / SCHEDULES ==========
  const storePath = path.join(app.getPath('userData'), 'store.json');
  registerStoreRoutes(expressApp, { storePath, zernioPost, hostImage });

  return new Promise((resolve) => {
    server = expressApp.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
      resolve();
    });
  });
}

// ========== ELECTRON ==========
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1000, minHeight: 600,
    title: 'Pinterest Dashboard',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    autoHideMenuBar: true, show: false
  });
  mainWindow.loadURL(`http://localhost:${PORT}`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  killPort(PORT);
  initKeysFile();
  await startServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (server) {
    server.closeAllConnections();
    server.close();
  }
  app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
