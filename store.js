const fs = require('fs');
const path = require('path');

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const DEFAULT_SETTINGS = { timezone: 'Asia/Jakarta', postingTimes: ['09:00', '13:00', '17:00', '20:00'] };

function emptyStore() { return { drafts: [], schedules: [], settings: { ...DEFAULT_SETTINGS, postingTimes: [...DEFAULT_SETTINGS.postingTimes] } }; }

function loadStore(storePath) {
  let data = emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch { data = emptyStore(); }
  if (!Array.isArray(data.drafts)) data.drafts = [];
  if (!Array.isArray(data.schedules)) data.schedules = [];
  if (!data.settings || typeof data.settings !== 'object') data.settings = { ...DEFAULT_SETTINGS, postingTimes: [...DEFAULT_SETTINGS.postingTimes] };
  if (!Array.isArray(data.settings.postingTimes) || !data.settings.postingTimes.length) data.settings.postingTimes = [...DEFAULT_SETTINGS.postingTimes];
  if (!data.settings.timezone) data.settings.timezone = DEFAULT_SETTINGS.timezone;
  return data;
}

function saveStore(storePath, data) {
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf8');
}

// Normalize a raw Shopee product OR an already-normalized item into a stored item.
function normItem(raw) {
  raw = raw || {};
  const images = Array.isArray(raw.images) ? raw.images.filter(Boolean)
    : (raw.image ? [raw.image] : []);
  const title = String(raw.title || raw.nama_produk || '').slice(0, 100);
  return {
    id: raw.id || uid('it_'),
    productId: String(raw.productId || raw.product_id || ''),
    title,
    description: raw.description || raw.nama_produk || raw.title || '',
    price: raw.price || raw.harga || '',
    sales: raw.sales || raw.penjualan || '',
    commission: raw.commission || raw.komisi || '',
    image: raw.image || images[0] || '',
    images,
    productLink: raw.productLink || raw.link_produk || '',
    affiliateLink: raw.affiliateLink || raw.link_komisi || '',
    store: raw.store || raw.nama_toko || '',
    addedAt: raw.addedAt || new Date().toISOString()
  };
}

// Assign a date/time to item `index` (0-based) given a start date and posts/day.
function slotDate(startDate, postsPerDay, index) {
  const per = Math.max(1, parseInt(postsPerDay) || 1);
  const base = new Date(`${startDate}T09:00:00`);
  const dayOffset = Math.floor(index / per);
  const posInDay = index % per;
  const stepMin = Math.round(posInDay * (9 * 60) / per);
  return new Date(base.getTime() + dayOffset * 86400000 + stepMin * 60000);
}

function computeEndDate(startDate, postsPerDay, count) {
  const per = Math.max(1, parseInt(postsPerDay) || 1);
  const parts = String(startDate).split('-').map(Number);
  const d = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
  d.setDate(d.getDate() + Math.floor(Math.max(0, count - 1) / per));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Detect whether a Zernio API response indicates an account-level problem
// (billing/subscription/suspension) rather than a per-post validation error.
// Returns null when it is not an account issue.
function classifyAccountIssue(d) {
  if (!d || typeof d !== 'object') return null;
  const code = d.code || '';
  const errText = typeof d.error === 'string' ? d.error : (d.error ? JSON.stringify(d.error) : (d.message || ''));
  const accountCodes = ['PAYMENT_REQUIRED', 'ACCOUNT_PAUSED', 'ACCOUNT_SUSPENDED', 'SUBSCRIPTION_REQUIRED', 'PLAN_LIMIT_REACHED', 'BILLING_REQUIRED'];
  const billingUrl = d.billingUrl || d.billing_url || (d.error && typeof d.error === 'object' ? d.error.billingUrl : null) || null;
  if (accountCodes.includes(code)) {
    return { code: code || 'ACCOUNT_ISSUE', message: errText || 'Akun Zernio bermasalah', billingUrl };
  }
  if (/account paused|payment required|subscription required|plan limit|akun (di)?(pause|suspend)|di-?suspend|diblokir/i.test(errText)) {
    return { code: code || 'ACCOUNT_ISSUE', message: errText, billingUrl };
  }
  return null;
}

function buildPinBody(item, schedule, mediaUrl) {
  const psd = { title: item.title || String(item.description || '').slice(0, 100) || 'Pin' };
  if (schedule.boardId) psd.boardId = schedule.boardId;
  const link = item.affiliateLink || item.productLink;
  if (link) psd.link = link;
  if (!mediaUrl) return null;
  return {
    title: item.title || undefined,
    content: item.description || item.title || '',
    mediaItems: [{ type: 'image', url: mediaUrl }],
    platforms: [{ platform: 'pinterest', accountId: schedule.accountId, platformSpecificData: psd }],
    publishNow: false,
    isDraft: false,
    scheduledFor: item.scheduledFor
  };
}

// Register /api/store, /api/drafts*, /api/schedules* routes on an express app.
// opts: { storePath, zernioPost, hostImage }
function registerStoreRoutes(app, opts) {
  const { storePath, zernioPost, hostImage } = opts;

  app.get('/api/store', (req, res) => {
    res.json(loadStore(storePath));
  });

  // Persist master settings (timezone + master posting times)
  app.post('/api/settings', (req, res) => {
    const data = loadStore(storePath);
    const s = req.body || {};
    if (typeof s.timezone === 'string' && s.timezone) data.settings.timezone = s.timezone;
    if (Array.isArray(s.postingTimes)) {
      const times = s.postingTimes.filter(t => typeof t === 'string' && /^\d{1,2}:\d{2}$/.test(t));
      if (times.length) data.settings.postingTimes = times;
    }
    saveStore(storePath, data);
    res.json({ success: true, settings: data.settings });
  });

  // Add items to drafts (dedupe by productId, else by id)
  app.post('/api/drafts', (req, res) => {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'Tidak ada item' });
    const data = loadStore(storePath);
    const seen = new Set(data.drafts.map(d => d.productId || d.id));
    let added = 0, skipped = 0;
    items.forEach(raw => {
      const it = normItem(raw);
      const key = it.productId || it.id;
      if (seen.has(key)) { skipped++; return; }
      seen.add(key);
      data.drafts.push(it);
      added++;
    });
    saveStore(storePath, data);
    res.json({ success: true, added, skipped, total: data.drafts.length, drafts: data.drafts });
  });

  app.post('/api/drafts/delete', (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
    const data = loadStore(storePath);
    const before = data.drafts.length;
    data.drafts = data.drafts.filter(d => !ids.includes(String(d.id)) && !ids.includes(String(d.productId)));
    saveStore(storePath, data);
    res.json({ success: true, removed: before - data.drafts.length, drafts: data.drafts });
  });

  app.delete('/api/drafts/:id', (req, res) => {
    const data = loadStore(storePath);
    data.drafts = data.drafts.filter(d => String(d.id) !== req.params.id && String(d.productId) !== req.params.id);
    saveStore(storePath, data);
    res.json({ success: true, drafts: data.drafts });
  });

  app.post('/api/drafts/clear', (req, res) => {
    const data = loadStore(storePath);
    data.drafts = [];
    saveStore(storePath, data);
    res.json({ success: true });
  });

  app.get('/api/schedules', (req, res) => {
    res.json({ schedules: loadStore(storePath).schedules });
  });

  app.get('/api/schedules/:id', (req, res) => {
    const s = loadStore(storePath).schedules.find(x => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: 'Penjadwalan tidak ditemukan' });
    res.json({ schedule: s });
  });

  // Create a schedule: { name, accountId, boardId, postsPerDay, startDate, items[] }
  app.post('/api/schedules', (req, res) => {
    const { name, accountId, boardId, postsPerDay, startDate } = req.body;
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (!rawItems.length) return res.status(400).json({ error: 'Tidak ada item untuk dijadwalkan' });
    if (!startDate) return res.status(400).json({ error: 'Tanggal mulai wajib diisi' });
    const perDay = Math.max(1, parseInt(postsPerDay) || 1);
    const items = rawItems.map((raw, i) => {
      const it = normItem(raw);
      it.scheduledFor = slotDate(startDate, perDay, i).toISOString();
      it.publishStatus = 'pending';
      it.postId = null;
      return it;
    });
    const schedule = {
      id: uid('sch_'),
      name: (name || '').trim() || `Penjadwalan ${new Date().toLocaleDateString('id-ID')}`,
      accountId: accountId || null,
      boardId: boardId || null,
      postsPerDay: perDay,
      startDate,
      endDate: computeEndDate(startDate, perDay, items.length),
      status: 'scheduled',
      createdAt: new Date().toISOString(),
      publishedAt: null,
      items
    };
    const data = loadStore(storePath);
    data.schedules.unshift(schedule);
    saveStore(storePath, data);
    res.json({ success: true, schedule, schedules: data.schedules });
  });

  app.delete('/api/schedules/:id', (req, res) => {
    const data = loadStore(storePath);
    const before = data.schedules.length;
    data.schedules = data.schedules.filter(s => s.id !== req.params.id);
    saveStore(storePath, data);
    res.json({ success: true, removed: before - data.schedules.length, schedules: data.schedules });
  });

  // Push a schedule to Zernio (each item becomes a scheduled Pinterest post)
  app.post('/api/schedules/:id/publish', async (req, res) => {
    const data = loadStore(storePath);
    const schedule = data.schedules.find(s => s.id === req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Penjadwalan tidak ditemukan' });
    if (!schedule.accountId) return res.status(400).json({ error: 'Schedule tidak memiliki accountId' });

    let ok = 0, failed = 0, accountIssue = null;
    for (const item of schedule.items) {
      if (item.publishStatus === 'published' && item.postId) { ok++; continue; }

      // Pinterest rejects hot-linked marketplace images; re-host each image on
      // Zernio storage first, then reference the hosted URL in the pin.
      const sourceUrl = item.image || (item.images && item.images[0]) || '';
      let mediaUrl = item.hostedImage || '';
      if (!mediaUrl) {
        if (!sourceUrl) {
          item.publishStatus = 'failed';
          item.publishError = 'Tidak ada gambar';
          failed++;
          continue;
        }
        if (hostImage) {
          try {
            mediaUrl = await hostImage(sourceUrl);
            item.hostedImage = mediaUrl;
          } catch (e) {
            const issue = classifyAccountIssue(e);
            if (issue) { accountIssue = issue; break; }
            item.publishStatus = 'failed';
            item.publishError = 'Gagal upload gambar: ' + e.message;
            failed++;
            continue;
          }
        } else {
          mediaUrl = sourceUrl;
        }
      }

      const body = buildPinBody(item, schedule, mediaUrl);
      if (!body) {
        item.publishStatus = 'failed';
        item.publishError = 'Tidak ada gambar';
        failed++;
        continue;
      }
      try {
        const d = await zernioPost('/posts', body);
        const issue = classifyAccountIssue(d);
        if (issue) { accountIssue = issue; break; }
        const id = d && (d._id || d.id || d.postId);
        if (d && !d.error && id) {
          item.postId = id;
          item.publishStatus = 'published';
          item.publishError = null;
          ok++;
        } else {
          item.publishStatus = 'failed';
          item.publishError = d && d.error ? (typeof d.error === 'string' ? d.error : JSON.stringify(d.error)) : 'Gagal membuat post';
          failed++;
        }
      } catch (e) {
        const issue = classifyAccountIssue({ error: e.message });
        if (issue) { accountIssue = issue; break; }
        item.publishStatus = 'failed';
        item.publishError = e.message;
        failed++;
      }
    }

    // If the whole account is in a bad state (billing/suspension), stop early
    // and report the real problem instead of marking every item as failed.
    if (accountIssue) {
      saveStore(storePath, data);
      return res.status(402).json({
        success: false,
        accountIssue: true,
        code: accountIssue.code,
        error: accountIssue.message,
        billingUrl: accountIssue.billingUrl,
        ok, failed
      });
    }
    schedule.status = failed === 0 ? 'published' : (ok > 0 ? 'partial' : 'failed');
    if (ok > 0) schedule.publishedAt = new Date().toISOString();
    saveStore(storePath, data);
    res.json({ success: true, schedule, ok, failed });
  });
}

module.exports = { registerStoreRoutes, loadStore, saveStore, normItem, slotDate, computeEndDate, uid, classifyAccountIssue };
