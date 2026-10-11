// ========== STATE ==========
let currentAccountId = null, currentProfileId = null, currentPageName = '';
let currentFans = 0, currentPinCount = 0, currentMonthlyViews = 0, currentBoardCount = 0;
let uploadedMedia = [], charts = {}, bulkItems = [], boards = [];
let calYear, calMonth, calendarPosts = [];

// Mass upload / drafts / schedules state
const DEFAULT_SETTINGS = { timezone: 'Asia/Jakarta', postingTimes: ['09:00', '13:00', '17:00', '20:00'] };
let storeData = { drafts: [], schedules: [], settings: { ...DEFAULT_SETTINGS, postingTimes: [...DEFAULT_SETTINGS.postingTimes] } };
let parsedProducts = [];            // products from uploaded JSON
let selectedProductIds = new Set();
let selectedDraftIds = new Set();
let scheduleSource = null;          // { source:'products'|'drafts', items:[] }
let schCalYear, schCalMonth, schDetailId = null;
let csvProducts = [];               // products uploaded on the Export CSV page
let selectedCsvProductIds = new Set();
let selectedCsvDraftIds = new Set();
let remoteScheduledPosts = [];      // pins already scheduled on Pinterest (via Zernio)

// ========== INIT ==========
document.addEventListener('DOMContentLoaded', async () => {
  initNavigation(); initTabs(); initContentTypeTabs(); initUploadZone();
  initPostForm(); initDateRange(); initBulkUpload(); initInsightDates();
  initKeyModals(); initBoardModals(); initMassUpload(); initCsvExport(); initSchedule();
  const now = new Date(); calYear = now.getFullYear(); calMonth = now.getMonth();
  schCalYear = now.getFullYear(); schCalMonth = now.getMonth();
  loadPages().catch(e => console.error('Pages load failed:', e));
  await loadStore();
  await loadAccount();
  checkAccountStatus();
  await loadDashboard();
});

// ========== PAGE SELECTOR ==========
let availablePages = [];

async function loadPages() {
  try {
    const res = await fetch('/api/pages');
    const data = await res.json();
    availablePages = data.pages || [];
    const sel = document.getElementById('pageSelector');
    if (!availablePages.length) {
      sel.innerHTML = '<option value="">Tidak ada akun</option>';
      return;
    }
    const prev = sel.value;
    sel.innerHTML = availablePages.map(p =>
      `<option value="${p.index}" ${p.isActive ? 'selected' : ''}>${p.pageName}</option>`
    ).join('');
    if (prev !== '') sel.value = prev;
  } catch(e) {
    console.error('Failed to load pages:', e);
  }
}

async function switchPageAccount(index) {
  const overlay = document.getElementById('switchOverlay');
  const overlayText = document.getElementById('overlayText');
  const pageName = availablePages[index]?.pageName || 'Pinterest ' + (parseInt(index)+1);
  overlayText.textContent = `Mengganti akun ke ${pageName}...`;
  overlay.style.display = 'flex';
  try {
    const res = await fetch('/api/switch-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: parseInt(index) })
    });
    const data = await res.json();
    if (data.success) {
      currentAccountId = null; currentProfileId = null; currentPageName = '';
      currentFans = 0; currentPinCount = 0; currentMonthlyViews = 0; currentBoardCount = 0;
      uploadedMedia = []; bulkItems = []; calendarPosts = []; boards = [];
      Object.values(charts).forEach(c => c.destroy()); charts = {};
      resetPostForm(); clearBulk();
      await loadAccount();
      const active = document.querySelector('.nav-item.active');
      const page = active ? active.dataset.page : 'dashboard';
      switchPage(page);
      toast(`Beralih ke ${currentPageName || pageName}`, 'success');
    }
  } catch(e) { toast('Gagal switch: ' + e.message, 'error'); }
  overlay.style.display = 'none';
}

// ========== NAV ==========
function initNavigation() {
  document.querySelectorAll('.nav-item').forEach(i => i.addEventListener('click', e => {
    e.preventDefault(); switchPage(i.dataset.page);
  }));
}

function initKeyModals() {
  document.getElementById('btnSubmitNewKey').addEventListener('click', submitNewKey);
  document.getElementById('btnConfirmDeleteKey').addEventListener('click', confirmDeleteKey);
  document.getElementById('newApiKeyInput').addEventListener('keydown', e => { if (e.key === 'Enter') submitNewKey(); });
  document.getElementById('deleteKeyModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeDeleteKeyModal(); });
  document.getElementById('addKeyModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeAddKeyModal(); });
}

function initBoardModals() {
  document.getElementById('btnSubmitNewBoard').addEventListener('click', submitNewBoard);
  document.getElementById('createBoardModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeCreateBoardModal(); });
}

function switchPage(p) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${p}"]`).classList.add('active');
  document.querySelectorAll('.page').forEach(pg => pg.classList.remove('active'));
  document.getElementById(`page-${p}`).classList.add('active');
  const t = { dashboard:'Dashboard', 'create-post':'Buat Pin', posts:'Semua Pin', insights:'Insights', followers:'Followers', boards:'Boards', 'mass-upload':'Mass Upload', 'csv-export':'Export CSV', schedule:'Schedule', settings:'Pengaturan' };
  document.getElementById('pageTitle').textContent = t[p] || p;
  if (p === 'posts') loadPosts();
  if (p === 'insights') initInsightDates();
  if (p === 'followers') loadFollowers();
  if (p === 'dashboard') loadDashboard();
  if (p === 'boards') loadBoards();
  if (p === 'settings') loadConnectedKeys();
  if (p === 'create-post') ensureBoardsLoaded();
  if (p === 'mass-upload') { ensureBoardsLoaded(); renderProducts(); renderDrafts(); }
  if (p === 'csv-export') { ensureBoardsLoaded(); renderCsvProducts(); renderCsvDrafts(); renderCsvTimezoneSelect(); renderCsvTimes(); renderCsvPreview(); }
  if (p === 'schedule') { loadSchedules(); }
}
function initDateRange() { document.getElementById('dateRange').addEventListener('change', () => loadDashboard()); }

// ========== TABS ==========
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => {
    const tab = b.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById(`tab-${tab}`).classList.add('active');
  }));
}

// ========== ACCOUNT ==========
async function loadAccount() {
  try {
    const res = await fetch('/api/accounts?platform=pinterest');
    const data = await res.json();
    const accounts = data.accounts || [];
    if (!accounts.length) { toast('Tidak ada akun Pinterest terhubung', 'error'); return; }
    const a = accounts[0];
    currentAccountId = a._id;
    currentPageName = a.displayName || a.username || '?';
    currentFans = a.followersCount || 0;
    document.getElementById('pageName').textContent = currentPageName;
    const avatar = document.getElementById('pageAvatar');
    avatar.innerHTML = a.profilePicture ? `<img src="${a.profilePicture}" onerror="this.parentElement.textContent='?'">` : currentPageName.charAt(0).toUpperCase();
    if (a.profileId) currentProfileId = typeof a.profileId === 'object' ? a.profileId._id : a.profileId;
    document.getElementById('settAccountId').textContent = currentAccountId;
    document.getElementById('settPageName').textContent = a.username || currentPageName;
    document.getElementById('settPageUrl').textContent = a.profileUrl || ('https://pinterest.com/' + (a.username || ''));
    document.getElementById('settStatus').textContent = a.isActive !== false ? 'Connected' : 'Disconnected';
    await ensureBoardsLoaded();
    document.getElementById('settBoards').textContent = currentBoardCount;
    toast(`Terhubung: ${currentPageName} (${formatNumber(currentFans)} followers)`, 'success');
  } catch(e) { toast('Gagal load akun: ' + e.message, 'error'); }
}

// ========== ACCOUNT HEALTH BANNER ==========
const ACCOUNT_ISSUE_TITLES = {
  PAYMENT_REQUIRED: 'Pembayaran diperlukan',
  BILLING_REQUIRED: 'Pembayaran diperlukan',
  ACCOUNT_PAUSED: 'Akun Zernio dijeda',
  ACCOUNT_SUSPENDED: 'Akun Zernio di-suspend',
  SUBSCRIPTION_REQUIRED: 'Langganan diperlukan',
  PLAN_LIMIT_REACHED: 'Limit plan tercapai'
};

function showAccountBanner(info) {
  if (!info) return;
  const el = document.getElementById('accountBanner');
  if (!el) return;
  const title = ACCOUNT_ISSUE_TITLES[info.code] || 'Akun bermasalah';
  document.getElementById('accountBannerTitle').textContent = title;
  document.getElementById('accountBannerMsg').textContent = info.message || 'Zernio melaporkan masalah pada akun ini.';
  const link = document.getElementById('accountBannerLink');
  if (info.billingUrl) { link.href = info.billingUrl; link.style.display = ''; }
  else { link.style.display = 'none'; }
  el.style.display = 'flex';
}

function dismissAccountBanner() {
  const el = document.getElementById('accountBanner');
  if (el) el.style.display = 'none';
}

async function checkAccountStatus() {
  try {
    const r = await fetch('/api/account-status');
    const d = await r.json();
    if (d && d.accountIssue) { showAccountBanner(d); return false; }
    dismissAccountBanner();
    return true;
  } catch (e) { return true; }
}

async function ensureBoardsLoaded() {
  if (!currentAccountId) return;
  try {
    const r = await fetch(`/api/accounts/${currentAccountId}/pinterest-boards`);
    const d = await r.json();
    boards = d.boards || [];
    currentBoardCount = boards.length;
    const opts = '<option value="">Board default</option>' + boards.map(b =>
      `<option value="${b.id}">${escapeHtml(b.name)}</option>`
    ).join('');
    fillBoardSelects(opts);
  } catch(e) { console.error('boards', e); }
}

function fillBoardSelects(opts) {
  ['pinBoard', 'bulkBoard', 'massBoard', 'draftBoard', 'csvBoard'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { const cur = el.value; el.innerHTML = opts; if (cur) el.value = cur; }
  });
}

// ========== DASHBOARD ==========
// Render the calendar from local scheduled pins first, then merge in the pins
// that are scheduled on Pinterest (via Zernio). Works even if the account fetch
// is slow or fails, so a successfully scheduled pin is never hidden.
async function loadCalendarPosts() {
  calendarPosts = [...localSchedulePosts()];
  renderCalendar();
  if (!currentAccountId) return;
  try {
    const [r1, r2] = await Promise.all([
      fetch(`/api/posts?platform=pinterest&limit=100&source=zernio`),
      fetch(`/api/posts?platform=pinterest&limit=100&source=external&accountId=${currentAccountId}`)
    ]);
    const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
    calendarPosts = [...(d1.posts || []), ...(d2.posts || []), ...localSchedulePosts()];
    calendarPosts.sort((a, b) => {
      const da = a.publishedAt || a.scheduledFor || a.createdAt || '';
      const db = b.publishedAt || b.scheduledFor || b.createdAt || '';
      return db.localeCompare(da);
    });
    renderCalendar();
  } catch (e) { console.error(e); }
}

async function loadDashboard() {
  loadCalendarPosts();
  if (!currentAccountId) return;
  document.getElementById('kpiFollowers').textContent = formatNumber(currentFans);
  document.getElementById('kpiBoards').textContent = formatNumber(currentBoardCount);

  const days = parseInt(document.getElementById('dateRange').value);
  const until = new Date().toISOString().split('T')[0];
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

  // Account stats (pins, monthly views) via follower stats
  try {
    const r = await fetch(`/api/accounts/follower-stats?accountIds=${currentAccountId}&granularity=daily`);
    const d = await r.json();
    const aid = Object.keys(d.stats || {})[0];
    const acc = d.accounts?.find(x => x._id === aid) || d.accounts?.[0];
    const st = acc?.accountStats;
    if (st) {
      currentPinCount = st.pinCount || 0;
      currentMonthlyViews = st.monthlyViews || 0;
      if (st.boardCount) { currentBoardCount = st.boardCount; document.getElementById('kpiBoards').textContent = formatNumber(currentBoardCount); }
    }
    document.getElementById('kpiPins').textContent = formatNumber(currentPinCount);
    document.getElementById('kpiMonthlyViews').textContent = formatNumber(currentMonthlyViews);
  } catch(e) { console.error(e); }

  // Daily metrics for charts + totals
  try {
    const r = await fetch(`/api/analytics/daily-metrics?platform=pinterest&accountId=${currentAccountId}&fromDate=${since}&toDate=${until}`);
    const d = await r.json();
    const daily = d.dailyData || [];
    const sum = (key) => daily.reduce((a, x) => a + ((x.metrics && x.metrics[key]) || 0), 0);
    document.getElementById('kpiSaves').textContent = formatNumber(sum('saves'));
    document.getElementById('kpiImpressions').textContent = formatNumber(sum('impressions'));
    if (daily.length) {
      renderLineChart('chartImpressions', daily.map(x => ({ date: x.date, value: x.metrics?.impressions || 0 })), '#e60023');
      renderLineChart('chartSaves', daily.map(x => ({ date: x.date, value: x.metrics?.saves || 0 })), '#f7b928');
      renderLineChart('chartClicks', daily.map(x => ({ date: x.date, value: x.metrics?.clicks || 0 })), '#06b6d4');
    } else {
      showEmptyChart('chartImpressions', 'Belum ada data');
      showEmptyChart('chartSaves', 'Belum ada data');
      showEmptyChart('chartClicks', 'Belum ada data');
    }
  } catch(e) { console.error(e); }

  try {
    const r = await fetch(`/api/analytics?platform=pinterest&accountId=${currentAccountId}&fromDate=${since}&toDate=${until}&sortBy=engagement&order=desc&limit=20`);
    const d = await r.json();
    processTopPins(d.posts || []);
  } catch(e) { console.error(e); }
}

function processTopPins(posts) {
  const tb = document.getElementById('topPostsBody');
  if (!posts.length) { tb.innerHTML = '<tr><td colspan="6" class="loading-cell">Belum ada data</td></tr>'; return; }
  tb.innerHTML = posts.slice(0,10).map(p => {
    const an = p.analytics || {};
    const eng = (an.likes||0)+(an.comments||0)+(an.shares||0)+(an.saves||0);
    return `<tr>
      <td class="post-content-cell">${escapeHtml(p.content || '(media)').substring(0,80)}</td>
      <td>${fmtDate(p.publishedAt||p.scheduledFor||p.createdAt)}</td>
      <td>${formatNumber(an.impressions||0)}</td>
      <td>${formatNumber(an.saves||0)}</td>
      <td>${formatNumber(an.clicks||0)}</td>
      <td>${formatNumber(eng)}</td>
    </tr>`;
  }).join('');
}

// ========== CALENDAR ==========
function renderCalendar() {
  const grid = document.getElementById('calendarGrid');
  const label = document.getElementById('calMonthLabel');
  const months = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  label.textContent = `${months[calMonth]} ${calYear}`;

  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const dayNames = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];

  let html = dayNames.map(d => `<div class="cal-header">${d}</div>`).join('');
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-day empty"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = dateStr === todayStr;
    const dayPosts = calendarPosts.filter(p => {
      const pd = (p.publishedAt || p.scheduledFor || p.createdAt || '');
      return pd.startsWith(dateStr);
    });
    const cls = ['cal-day'];
    if (isToday) cls.push('today');
    if (dayPosts.length) cls.push('has-post');

    let tooltip = '';
    if (dayPosts.length) {
      tooltip = '<div class="cal-tooltip">' + dayPosts.slice(0,5).map(p => {
        const st = p.status === 'scheduled' ? 'scheduled' : '';
        const icon = st ? '&#9200;' : '&#10003;';
        const txt = p.title || p.content || '(media)';
        return `<div class="cal-tooltip-item">${icon} ${escapeHtml(txt).substring(0,40)}</div>`;
      }).join('') + (dayPosts.length > 5 ? `<div class="cal-tooltip-item">+${dayPosts.length - 5} lagi...</div>` : '') + '</div>';
    }

    html += `<div class="${cls.join(' ')}">
      <div class="day-num">${d}</div>
      ${dayPosts.length ? `<div class="cal-post-count">${dayPosts.length} pin</div>` : ''}
      ${tooltip}
    </div>`;
  }
  grid.innerHTML = html;
}

function calPrev() { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); }
function calNext() { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); }

// ========== CHARTS ==========
const CHART_OPTS = {
  responsive: true, maintainAspectRatio: false, animation: false,
  plugins: { legend: { display: false } },
  scales: {
    x: { grid: { color: '#2e324118', drawBorder: false }, ticks: { color: '#a0a3b1', maxTicksLimit: 8, font: { size: 10 }, padding: 4 }, border: { display: false } },
    y: { grid: { color: '#2e324118', drawBorder: false }, ticks: { color: '#a0a3b1', font: { size: 10 }, padding: 4 }, border: { display: false } }
  }
};

function makeChart(id, cfg) {
  const c = document.getElementById(id); if (!c) return;
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  charts[id] = new Chart(c, cfg);
}

function renderLineChart(id, values, color) {
  if (!values?.length) return;
  makeChart(id, { type: 'line', data: { labels: values.map(v => v.date), datasets: [{ data: values.map(v => v.value), borderColor: color, backgroundColor: color + '18', fill: true, tension: 0.4, pointRadius: 0, pointHoverRadius: 3, borderWidth: 2 }] }, options: { ...CHART_OPTS } });
}

function renderBarChart(id, labels, data, colors) {
  makeChart(id, { type: 'bar', data: { labels, datasets: [{ data, backgroundColor: colors || ['#e60023','#f7b928','#06b6d4','#42b72a','#a855f7'], borderRadius: 4, barThickness: 24 }] }, options: { ...CHART_OPTS } });
}

function showEmptyChart(id, msg) {
  makeChart(id, { type: 'bar', data: { labels: [''], datasets: [{ data: [0], backgroundColor: '#2e3241', borderRadius: 4 }] },
    options: { ...CHART_OPTS, plugins: { legend: { display: false }, title: { display: true, text: msg, color: '#a0a3b1', font: { size: 11 } } }, scales: { x: { display: false }, y: { display: false } } } });
}

// ========== CREATE PIN ==========
function initContentTypeTabs() {
  document.querySelectorAll('.ctab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.ctab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const type = t.dataset.type;
    const fi = document.getElementById('mediaFileInput');
    const hint = document.getElementById('uploadHint');
    if (type === 'video') { fi.accept = 'video/*'; hint.textContent = 'Video MP4/MOV. Max 25MB'; }
    else { fi.accept = 'image/*'; hint.textContent = 'Gambar JPG/PNG/WEBP. Max 25MB'; }
    uploadedMedia = []; renderMediaPreviews();
  }));
}

function initUploadZone() {
  const z = document.getElementById('uploadZone'), fi = document.getElementById('mediaFileInput');
  z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('dragover'); });
  z.addEventListener('dragleave', () => z.classList.remove('dragover'));
  z.addEventListener('drop', e => { e.preventDefault(); z.classList.remove('dragover'); handleFiles(e.dataTransfer.files); });
  z.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => { handleFiles(fi.files); fi.value = ''; });
}

async function handleFiles(files) {
  for (const f of files) {
    if (f.size > 25*1024*1024) { toast(`${f.name} max 25MB`, 'error'); continue; }
    toast(`Uploading ${f.name}...`, 'info');
    try {
      const pr = await fetch('/api/media/presign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: f.name, contentType: f.type, size: f.size }) });
      const pd = await pr.json();
      if (pd.error) throw new Error(pd.error);
      await fetch(pd.uploadUrl, { method: 'PUT', headers: { 'Content-Type': f.type }, body: f });
      uploadedMedia.push({ type: f.type.startsWith('video/') ? 'video' : 'image', url: pd.publicUrl, filename: f.name, size: f.size, mimeType: f.type });
      renderMediaPreviews(); toast(`${f.name} OK`, 'success');
    } catch(e) { toast(`Gagal: ${e.message}`, 'error'); }
  }
}

function renderMediaPreviews() {
  document.getElementById('mediaPreviewList').innerHTML = uploadedMedia.map((m,i) => `<div class="media-preview-item">${m.type==='video'?`<video src="${m.url}" muted></video>`:`<img src="${m.url}">`}<button class="media-preview-remove" onclick="removeMedia(${i})">&times;</button></div>`).join('');
}
function removeMedia(i) { uploadedMedia.splice(i,1); renderMediaPreviews(); }

function initPostForm() {
  document.getElementById('btnSubmitPost').addEventListener('click', submitPost);
  document.getElementById('btnPublishNow').addEventListener('click', () => { document.getElementById('postSchedule').value = ''; });
}

async function submitPost() {
  if (!currentAccountId) { toast('Akun belum dimuat', 'error'); return; }
  const title = document.getElementById('pinTitle').value.trim();
  const content = document.getElementById('postContent').value;
  const link = document.getElementById('pinLink').value.trim();
  const boardId = document.getElementById('pinBoard').value;
  const altText = document.getElementById('pinAltText').value.trim();
  const schedule = document.getElementById('postSchedule').value;
  const isDraft = document.getElementById('postAsDraft').checked;
  const mediaUrl = document.getElementById('mediaUrl').value.trim();

  const media = uploadedMedia.map(m => ({ type: m.type, url: m.url, filename: m.filename, size: m.size, mimeType: m.mimeType, ...(altText ? { altText } : {}) }));
  if (mediaUrl) media.push({ type: /\.(mp4|mov|webm)$/i.test(mediaUrl) ? 'video' : 'image', url: mediaUrl, ...(altText ? { altText } : {}) });

  if (!media.length) { toast('Pin wajib memiliki media (gambar/video)', 'error'); return; }
  if (!content && !title) { toast('Isi judul atau deskripsi', 'error'); return; }

  const psd = { title: title || content.split('\n')[0].substring(0,100) || 'Pin' };
  if (boardId) psd.boardId = boardId;
  if (link) psd.link = link;

  const body = {
    title: title || undefined,
    content,
    mediaItems: media,
    platforms: [{ platform: 'pinterest', accountId: currentAccountId, platformSpecificData: psd }],
    publishNow: !schedule && !isDraft,
    isDraft
  };
  if (schedule) body.scheduledFor = new Date(schedule).toISOString();

  try {
    const r = await fetch('/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    const rb = document.getElementById('postResult'); rb.style.display = 'block';
    if (d.error) { rb.className = 'result-box error'; rb.textContent = 'Error: ' + (typeof d.error === 'string' ? d.error : d.error.message || JSON.stringify(d.error)); }
    else { rb.className = 'result-box success'; rb.innerHTML = '<strong>Berhasil!</strong> ID: ' + (d._id || d.id || d.postId || '-'); resetPostForm(); }
  } catch(e) { const rb = document.getElementById('postResult'); rb.style.display = 'block'; rb.className = 'result-box error'; rb.textContent = e.message; }
}

function resetPostForm() {
  document.getElementById('pinTitle').value = '';
  document.getElementById('postContent').value = ''; document.getElementById('postSchedule').value = '';
  document.getElementById('postAsDraft').checked = false; document.getElementById('mediaUrl').value = '';
  document.getElementById('pinLink').value = ''; document.getElementById('pinAltText').value = '';
  document.getElementById('pinBoard').value = '';
  uploadedMedia = []; renderMediaPreviews(); document.getElementById('postResult').style.display = 'none';
}

// ========== BULK PIN ==========
function initBulkUpload() {
  const fi = document.getElementById('bulkFolderInput');
  fi.addEventListener('change', () => processBulkFiles(fi.files));
}

async function processBulkFiles(fileList) {
  bulkItems = [];
  const folders = {};
  for (const f of fileList) {
    const parts = f.webkitRelativePath.split('/');
    if (parts.length < 3) continue;
    const folderName = parts[1];
    if (!folders[folderName]) folders[folderName] = { folder: folderName, caption: '', media: null, mediaName: '' };
    const fname = parts.slice(2).join('/');
    if (fname.toLowerCase() === 'caption.txt') {
      try { folders[folderName].caption = await f.text(); } catch(e) {}
    } else if (/\.(jpg|jpeg|png|gif|webp|mp4|mov|webm)$/i.test(fname)) {
      folders[folderName].media = f;
      folders[folderName].mediaName = fname;
    }
  }
  bulkItems = Object.values(folders).filter(f => f.media);
  renderBulkPreview();
}

function renderBulkPreview() {
  const c = document.getElementById('bulkCount');
  const items = document.getElementById('bulkItems');
  const preview = document.getElementById('bulkPreview');
  if (!bulkItems.length) { preview.style.display = 'none'; return; }
  preview.style.display = 'block';
  c.textContent = `${bulkItems.length} pin ditemukan`;
  items.innerHTML = bulkItems.map((b,i) => {
    const isVideo = /\.(mp4|mov|webm)$/i.test(b.mediaName);
    return `<div class="bulk-item">
      <div class="bulk-item-num">${i+1}</div>
      <div class="bulk-item-info">
        <div class="bulk-item-folder">${b.folder}</div>
        <div class="bulk-item-caption">${escapeHtml(b.caption.substring(0,80)) || '(no caption)'}</div>
        <div class="bulk-item-media">${isVideo ? '&#9654;' : '&#128247;'} ${b.mediaName.split('/').pop()}</div>
      </div>
      <span class="bulk-item-status pending" id="bulkStatus${i}">Pending</span>
    </div>`;
  }).join('');
  document.getElementById('btnBulkSubmit').textContent = `Kirim Semua (${bulkItems.length})`;
  document.getElementById('btnBulkSubmit').onclick = submitBulk;
}

function clearBulk() { bulkItems = []; document.getElementById('bulkPreview').style.display = 'none'; document.getElementById('bulkFolderInput').value = ''; }

async function submitBulk() {
  if (!currentAccountId || !bulkItems.length) return;
  const start = document.getElementById('bulkScheduleStart').value;
  const interval = parseInt(document.getElementById('bulkInterval').value) || 30;
  const boardId = document.getElementById('bulkBoard').value;
  const rb = document.getElementById('bulkResult'); rb.style.display = 'block'; rb.className = 'result-box info';
  rb.textContent = 'Mengirim...';

  let success = 0, failed = 0;
  for (let i = 0; i < bulkItems.length; i++) {
    const b = bulkItems[i];
    const statusEl = document.getElementById(`bulkStatus${i}`);
    try {
      const pr = await fetch('/api/media/presign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: b.media.name || b.mediaName, contentType: b.media.type || (/\.(mp4|mov|webm)$/i.test(b.mediaName) ? 'video/mp4' : 'image/jpeg'), size: b.media.size }) });
      const pd = await pr.json();
      if (pd.error) throw new Error(pd.error);
      await fetch(pd.uploadUrl, { method: 'PUT', headers: { 'Content-Type': b.media.type || 'application/octet-stream' }, body: b.media });

      const isVideo = /\.(mp4|mov|webm)$/i.test(b.mediaName);
      const caption = b.caption.trim();
      const title = caption.split('\n')[0].substring(0,100) || b.folder;
      const psd = { title };
      if (boardId) psd.boardId = boardId;
      const body = {
        title,
        content: caption,
        mediaItems: [{ type: isVideo ? 'video' : 'image', url: pd.publicUrl, filename: b.mediaName }],
        platforms: [{ platform: 'pinterest', accountId: currentAccountId, platformSpecificData: psd }],
        publishNow: !start,
        isDraft: false
      };
      if (start) {
        const schedDate = new Date(new Date(start).getTime() + i * interval * 60000);
        body.scheduledFor = schedDate.toISOString();
      }

      const r = await fetch('/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (d.error) throw new Error(typeof d.error === 'string' ? d.error : d.error.message);

      success++;
      if (statusEl) { statusEl.textContent = 'OK'; statusEl.className = 'bulk-item-status done'; }
    } catch(e) {
      failed++;
      if (statusEl) { statusEl.textContent = 'Gagal'; statusEl.className = 'bulk-item-status error'; }
    }
  }
  rb.className = failed ? 'result-box error' : 'result-box success';
  rb.textContent = `Selesai: ${success} berhasil, ${failed} gagal`;
  toast(`Bulk: ${success} OK, ${failed} gagal`, failed ? 'error' : 'success');
}

// ========== ALL PINS ==========
async function loadPosts(page = 1) {
  try {
    const [r1, r2] = await Promise.all([
      fetch(`/api/posts?platform=pinterest&page=${page}&limit=20&source=zernio`),
      fetch(`/api/posts?platform=pinterest&page=${page}&limit=20&source=external&accountId=${currentAccountId}`)
    ]);
    const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
    const allPosts = [...(d1.posts||[]), ...(d2.posts||[])];
    allPosts.sort((a,b) => {
      const da = a.publishedAt || a.scheduledFor || a.createdAt || '';
      const db = b.publishedAt || b.scheduledFor || b.createdAt || '';
      return db.localeCompare(da);
    });
    const tb = document.getElementById('allPostsBody');
    if (!allPosts.length) { tb.innerHTML = '<tr><td colspan="5" class="loading-cell">Belum ada pin. Pin organic dari Pinterest akan muncul setelah sync (~12 bulan terakhir).</td></tr>'; document.getElementById('postsPagination').innerHTML = ''; return; }
    tb.innerHTML = allPosts.map(p => {
      const s = (p.status || 'draft').toLowerCase();
      const pn = (p.platforms || []).map(pl => typeof pl === 'string' ? pl : pl.platform || '?').join(', ');
      const source = p.source === 'external' ? ' [organic]' : '';
      return `<tr><td class="post-content-cell">${escapeHtml(p.title || p.content || p.text || '').substring(0,120)}</td>
        <td><span class="status-badge status-${s}">${p.status||'?'}${source}</span></td>
        <td>${fmtDate(p.publishedAt||p.scheduledFor||p.createdAt)}</td><td>${pn||'pinterest'}</td>
        <td>${s==='scheduled'?`<button class="btn btn-danger btn-sm" onclick="deletePost('${p._id||p.id}')">Batal</button>`:''}</td></tr>`;
    }).join('');
    const tp = d1.pagination?.pages || d2.pagination?.pages || 1;
    const pg = document.getElementById('postsPagination'); pg.innerHTML = '';
    for (let i = 1; i <= Math.min(tp,10); i++) pg.innerHTML += `<button class="${i===page?'active':''}" onclick="loadPosts(${i})">${i}</button>`;
  } catch(e) { toast('Gagal: ' + e.message, 'error'); }
}

async function deletePost(id) {
  if (!confirm('Hapus?')) return;
  try { await fetch(`/api/posts/${id}`, { method: 'DELETE' }); toast('Dihapus', 'success'); loadPosts(); } catch(e) { toast(e.message, 'error'); }
}

// ========== INSIGHTS ==========
function initInsightDates() { updateInsightDateInputs(); }

function updateInsightDateInputs() {
  const p = document.getElementById('insightsPeriod').value;
  document.getElementById('insDateFromGroup').style.display = p === 'daily' ? '' : 'none';
  document.getElementById('insDateToGroup').style.display = p === 'daily' ? '' : 'none';
  document.getElementById('insMonthFromGroup').style.display = p === 'monthly' ? '' : 'none';
  document.getElementById('insMonthToGroup').style.display = p === 'monthly' ? '' : 'none';
  document.getElementById('insYearFromGroup').style.display = p === 'yearly' ? '' : 'none';
  document.getElementById('insYearToGroup').style.display = p === 'yearly' ? '' : 'none';

  const now = new Date();
  if (p === 'daily') {
    document.getElementById('insFrom').value = new Date(now - 30*86400000).toISOString().split('T')[0];
    document.getElementById('insTo').value = now.toISOString().split('T')[0];
  } else if (p === 'monthly') {
    document.getElementById('insMonthFrom').value = `${now.getFullYear()}-${String(now.getMonth()-2<1?12:now.getMonth()-2).padStart(2,'0')}`;
    document.getElementById('insMonthTo').value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  } else {
    document.getElementById('insYearFrom').value = now.getFullYear() - 1;
    document.getElementById('insYearTo').value = now.getFullYear();
  }
}

function resolveInsightDates() {
  const p = document.getElementById('insightsPeriod').value;
  let since, until;
  if (p === 'daily') {
    since = document.getElementById('insFrom').value;
    until = document.getElementById('insTo').value;
  } else if (p === 'monthly') {
    const mf = document.getElementById('insMonthFrom').value;
    const mt = document.getElementById('insMonthTo').value;
    since = mf ? `${mf}-01` : '';
    until = mt ? `${mt}-28` : '';
  } else {
    since = document.getElementById('insYearFrom').value ? `${document.getElementById('insYearFrom').value}-01-01` : '';
    until = document.getElementById('insYearTo').value ? `${document.getElementById('insYearTo').value}-12-31` : '';
  }
  return { since, until };
}

async function loadInsights() {
  if (!currentAccountId) return;
  const { since, until } = resolveInsightDates();
  if (!since || !until) { toast('Pilih tanggal', 'error'); return; }
  try {
    const r = await fetch(`/api/analytics/daily-metrics?platform=pinterest&accountId=${currentAccountId}&fromDate=${since}&toDate=${until}`);
    const d = await r.json();
    const daily = d.dailyData || [];
    if (!daily.length) { toast('Tidak ada data', 'error'); return; }
    const sum = (key) => daily.reduce((a, x) => a + ((x.metrics && x.metrics[key]) || 0), 0);
    const totalImp = sum('impressions'), totalSaves = sum('saves'), totalClicks = sum('clicks');
    document.getElementById('insTotalImpressions').textContent = formatNumber(totalImp);
    document.getElementById('insTotalSaves').textContent = formatNumber(totalSaves);
    document.getElementById('insTotalClicks').textContent = formatNumber(totalClicks);
    const days = Math.max(1, Math.ceil((new Date(until)-new Date(since))/86400000));
    document.getElementById('insAvgImpressions').textContent = formatNumber(Math.round(totalImp/days));

    renderLineChart('chartInsImpressions', daily.map(x => ({ date: x.date, value: x.metrics?.impressions || 0 })), '#e60023');
    renderLineChart('chartInsSaves', daily.map(x => ({ date: x.date, value: x.metrics?.saves || 0 })), '#f7b928');
    renderLineChart('chartInsClicks', daily.map(x => ({ date: x.date, value: x.metrics?.clicks || 0 })), '#06b6d4');

    renderBarChart('chartInsBreakdown',
      ['Impressions','Saves','Clicks','Likes','Shares'],
      [totalImp, totalSaves, totalClicks, sum('likes'), sum('shares')],
      ['#e60023','#f7b928','#06b6d4','#42b72a','#a855f7']);

    const tb = document.getElementById('insightsTableBody');
    const rows = [...daily].sort((a,b) => b.date.localeCompare(a.date));
    tb.innerHTML = rows.map(x => {
      const m = x.metrics || {};
      return `<tr><td>${x.date}</td><td>${formatNumber(x.postCount||0)}</td><td>${formatNumber(m.impressions||0)}</td><td>${formatNumber(m.saves||0)}</td><td>${formatNumber(m.clicks||0)}</td><td>${formatNumber(m.likes||0)}</td></tr>`;
    }).join('');
    toast('Insights loaded', 'success');
  } catch(e) { toast('Gagal: ' + e.message, 'error'); }
}

// ========== FOLLOWERS ==========
async function loadFollowers() {
  if (!currentAccountId) return;
  document.getElementById('flwTotal').textContent = formatNumber(currentFans);

  const granularity = document.getElementById('flwGranularity').value;
  try {
    const r = await fetch(`/api/accounts/follower-stats?accountIds=${currentAccountId}&granularity=${granularity}`);
    const d = await r.json();
    const aid = Object.keys(d.stats||{})[0];
    const stats = d.stats?.[aid] || [];

    if (!stats.length) {
      ['flwToday','flwYesterday','flwThisWeek','flwThisMonth','flwAvgDaily'].forEach(id => document.getElementById(id).textContent = '-');
      document.getElementById('flwTableBody').innerHTML = '<tr><td colspan="3" class="loading-cell">Belum ada data history</td></tr>';
      showEmptyChart('chartFlwHistory', 'Belum ada data');
      return;
    }

    const latest = stats[stats.length-1];
    const y = stats.length >= 2 ? stats[stats.length-2] : null;
    const w = stats.length >= 8 ? stats[stats.length-8] : null;
    const m = stats.length >= 31 ? stats[stats.length-31] : null;
    document.getElementById('flwToday').textContent = y ? (latest.followers-y.followers>=0?'+':'') + formatNumber(latest.followers-y.followers) : '-';
    document.getElementById('flwYesterday').textContent = y ? formatNumber(y.followers) : '-';
    document.getElementById('flwThisWeek').textContent = w ? '+' + formatNumber(latest.followers-w.followers) : '-';
    document.getElementById('flwThisMonth').textContent = m ? '+' + formatNumber(latest.followers-m.followers) : '-';
    if (stats.length >= 2) {
      const avg = Math.round((latest.followers - stats[0].followers) / stats.length);
      document.getElementById('flwAvgDaily').textContent = (avg>=0?'+':'') + formatNumber(avg);
    }

    renderLineChart('chartFlwHistory', stats.map(s => ({ date: s.date, value: s.followers })), '#e60023');

    const tb = document.getElementById('flwTableBody');
    const rev = [...stats].reverse();
    tb.innerHTML = rev.map((s,i) => {
      const prev = i < rev.length-1 ? rev[i+1] : null;
      const ch = prev ? s.followers - prev.followers : 0;
      return `<tr><td>${s.date}</td><td>${formatNumber(s.followers)}</td><td style="color:${ch>=0?'var(--green)':'var(--red)'}">${ch>=0?'+':''}${formatNumber(ch)}</td></tr>`;
    }).join('');

    toast('Followers loaded', 'success');
  } catch(e) { toast('Gagal: ' + e.message, 'error'); }
}

// ========== BOARDS ==========
async function loadBoards() {
  const grid = document.getElementById('boardsGrid');
  if (!currentAccountId) { grid.innerHTML = '<div class="keys-loading">Pilih akun terlebih dahulu</div>'; return; }
  grid.innerHTML = '<div class="keys-loading">Memuat boards...</div>';
  try {
    const r = await fetch(`/api/accounts/${currentAccountId}/pinterest-boards`);
    const d = await r.json();
    boards = d.boards || [];
    currentBoardCount = boards.length;
    const defaultBoardId = d.defaultBoardId || null;
    const opts = '<option value="">Board default</option>' + boards.map(b => `<option value="${b.id}" ${b.id===defaultBoardId?'selected':''}>${escapeHtml(b.name)}${b.id===defaultBoardId?' (default)':''}</option>`).join('');
    fillBoardSelects(opts);
    if (!boards.length) { grid.innerHTML = '<div class="keys-loading">Belum ada board</div>'; return; }
    grid.innerHTML = boards.map(b => `
      <div class="key-card ${b.id===defaultBoardId ? 'active' : ''}">
        <div class="key-card-top">
          <span class="key-card-badge connected">${escapeHtml(b.privacy || 'PUBLIC')}</span>
          ${b.id===defaultBoardId ? '<span class="key-card-badge default">Default</span>' : ''}
        </div>
        <div class="key-card-fanpage">
          <div class="key-card-icon">${b.imageCoverUrl ? `<img src="${b.imageCoverUrl}" onerror="this.parentElement.innerHTML='&#9645;'">` : '&#9645;'}</div>
          <div class="key-card-info">
            <div class="key-card-name">${escapeHtml(b.name || '-')}</div>
            <div class="key-card-fans">${escapeHtml((b.description || 'Tanpa deskripsi').substring(0,60))}</div>
          </div>
        </div>
        <div class="key-card-details">
          <span class="key-card-code">${escapeHtml(String(b.id))}</span>
          <div class="key-card-actions">
            ${b.id!==defaultBoardId ? `<button class="key-card-btn default" onclick="setDefaultBoard('${b.id}', '${escapeHtml(b.name||'')}')">Set Default</button>` : ''}
          </div>
        </div>
      </div>`).join('');
  } catch(e) {
    grid.innerHTML = '<div class="keys-loading" style="color:var(--red)">Gagal memuat: ' + e.message + '</div>';
  }
}

async function setDefaultBoard(boardId, boardName) {
  if (!currentAccountId) return;
  try {
    const r = await fetch(`/api/accounts/${currentAccountId}/pinterest-boards`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultBoardId: boardId, defaultBoardName: boardName })
    });
    const d = await r.json();
    if (d.error) throw new Error(typeof d.error === 'string' ? d.error : d.error.message);
    toast('Board default diperbarui', 'success');
    loadBoards();
  } catch(e) { toast('Gagal: ' + e.message, 'error'); }
}

function showCreateBoardModal() {
  document.getElementById('createBoardModal').style.display = 'flex';
  document.getElementById('newBoardName').value = '';
  document.getElementById('newBoardDesc').value = '';
  document.getElementById('newBoardPrivacy').value = 'PUBLIC';
  document.getElementById('createBoardError').style.display = 'none';
  document.getElementById('newBoardName').focus();
}
function closeCreateBoardModal() { document.getElementById('createBoardModal').style.display = 'none'; }

async function submitNewBoard() {
  if (!currentAccountId) { toast('Akun belum dimuat', 'error'); return; }
  const name = document.getElementById('newBoardName').value.trim();
  const description = document.getElementById('newBoardDesc').value.trim();
  const privacy = document.getElementById('newBoardPrivacy').value;
  const errBox = document.getElementById('createBoardError');
  if (!name) { errBox.textContent = 'Nama board wajib diisi'; errBox.style.display = 'block'; return; }
  const btn = document.getElementById('btnSubmitNewBoard');
  btn.disabled = true; btn.textContent = 'Membuat...';
  try {
    const r = await fetch(`/api/accounts/${currentAccountId}/pinterest-boards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, privacy })
    });
    const d = await r.json();
    if (d.error) throw new Error(typeof d.error === 'string' ? d.error : d.error.message);
    closeCreateBoardModal();
    toast('Board berhasil dibuat', 'success');
    loadBoards();
  } catch(e) {
    errBox.textContent = e.message; errBox.style.display = 'block';
  } finally { btn.disabled = false; btn.textContent = 'Buat Board'; }
}

// ========== UTILS ==========
function formatNumber(n) { if (n == null) return '-'; if (n >= 1e6) return (n/1e6).toFixed(1)+'M'; if (n >= 1e3) return (n/1e3).toFixed(1)+'K'; return Number(n).toLocaleString('id-ID'); }
function fmtDate(s) { if (!s) return '-'; try { return new Date(s).toLocaleDateString('id-ID', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); } catch { return s; } }
function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t == null ? '' : t; return d.innerHTML; }
function toast(msg, type='info') { const c = document.getElementById('toastContainer'); const t = document.createElement('div'); t.className = `toast ${type}`; t.textContent = msg; c.appendChild(t); setTimeout(() => t.remove(), 4000); }

// ========== API KEY MANAGEMENT ==========
let deleteKeyIdx = null;

async function loadConnectedKeys() {
  const container = document.getElementById('keysContainer');
  const empty = document.getElementById('keysEmpty');
  container.innerHTML = '<div class="keys-loading">Memuat koneksi...</div>';
  empty.style.display = 'none';
  try {
    const res = await fetch('/api/keys');
    const data = await res.json();
    const keys = data.keys || [];
    if (!keys.length) {
      container.style.display = 'none';
      empty.style.display = 'block';
      return;
    }
    container.style.display = 'grid';
    empty.style.display = 'none';
    container.innerHTML = keys.map(k => `
      <div class="key-card ${k.isActive ? 'active' : ''}">
        <div class="key-card-top">
          <span class="key-card-badge ${k.connected ? 'connected' : 'error'}">${k.connected ? 'Terhubung' : 'Tidak Terhubung'}</span>
          ${k.isActive ? '<span class="key-card-badge active">Aktif</span>' : ''}
        </div>
        <div class="key-card-fanpage">
          <div class="key-card-icon">${k.pageIcon ? `<img src="${k.pageIcon}" onerror="this.parentElement.innerHTML='&#9645;'">` : '&#9645;'}</div>
          <div class="key-card-info">
            <div class="key-card-name">${escapeHtml(k.pageName)}</div>
            <div class="key-card-fans">${k.connected ? formatNumber(k.boardCount) + ' boards' : 'Tidak ada data'}</div>
          </div>
        </div>
        <div class="key-card-details">
          <span class="key-card-code">${escapeHtml(k.keyPreview)}</span>
          <div class="key-card-actions">
            ${!k.isActive ? `<button class="key-card-btn switch" onclick="switchToKey(${k.index})">Aktifkan</button>` : ''}
            <button class="key-card-btn" onclick="showDeleteKeyModal(${k.index}, '${escapeHtml(k.keyPreview)}', '${escapeHtml(k.pageName)}')">Hapus</button>
          </div>
        </div>
      </div>
    `).join('');
  } catch(e) {
    container.innerHTML = '<div class="keys-loading" style="color:var(--red)">Gagal memuat: ' + e.message + '</div>';
  }
}

function showAddKeyModal() {
  document.getElementById('addKeyModal').style.display = 'flex';
  document.getElementById('newApiKeyInput').value = '';
  document.getElementById('addKeyError').style.display = 'none';
  document.getElementById('newApiKeyInput').focus();
}

function closeAddKeyModal() {
  document.getElementById('addKeyModal').style.display = 'none';
}

async function submitNewKey() {
  const input = document.getElementById('newApiKeyInput');
  const errBox = document.getElementById('addKeyError');
  const btn = document.getElementById('btnSubmitNewKey');
  const key = input.value.trim();
  if (!key) { errBox.textContent = 'Masukkan API key'; errBox.style.display = 'block'; return; }

  btn.disabled = true;
  btn.textContent = 'Validasi...';
  errBox.style.display = 'none';

  try {
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const data = await res.json();
    if (!res.ok) {
      errBox.textContent = data.error || 'Gagal menambah key';
      errBox.style.display = 'block';
      return;
    }
    closeAddKeyModal();
    toast('API key berhasil ditambahkan!', 'success');
    loadConnectedKeys();
    loadPages();
    loadAccount();
  } catch(e) {
    errBox.textContent = e.message;
    errBox.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Tambah & Validasi';
  }
}

function showDeleteKeyModal(index, keyPreview, pageName) {
  deleteKeyIdx = index;
  document.getElementById('deleteKeyName').textContent = keyPreview;
  document.getElementById('deleteKeyPage').textContent = pageName;
  document.getElementById('deleteKeyModal').style.display = 'flex';
}

function closeDeleteKeyModal() {
  deleteKeyIdx = null;
  document.getElementById('deleteKeyModal').style.display = 'none';
}

async function confirmDeleteKey() {
  if (deleteKeyIdx === null) return;
  const btn = document.getElementById('btnConfirmDeleteKey');
  btn.disabled = true;
  btn.textContent = 'Menghapus...';

  try {
    const res = await fetch(`/api/keys/${deleteKeyIdx}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menghapus');
    closeDeleteKeyModal();
    toast('API key berhasil dihapus', 'success');
    loadConnectedKeys();
    loadPages();
    loadAccount();
  } catch(e) {
    toast('Gagal: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Hapus';
  }
}

async function switchToKey(index) {
  const overlay = document.getElementById('switchOverlay');
  const overlayText = document.getElementById('overlayText');
  overlayText.textContent = 'Mengganti akun...';
  overlay.style.display = 'flex';
  try {
    const res = await fetch('/api/switch-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index })
    });
    const data = await res.json();
    if (data.success) {
      currentAccountId = null; currentProfileId = null; currentPageName = '';
      currentFans = 0; currentPinCount = 0; currentMonthlyViews = 0; currentBoardCount = 0;
      uploadedMedia = []; bulkItems = []; calendarPosts = []; boards = [];
      Object.values(charts).forEach(c => c.destroy()); charts = {};
      resetPostForm(); clearBulk();
      await loadAccount();
      loadConnectedKeys();
      loadPages();
      toast('Akun berhasil diganti', 'success');
    }
  } catch(e) { toast('Gagal: ' + e.message, 'error'); }
  overlay.style.display = 'none';
}

// ========== MASS UPLOAD ==========
function todayStr() { return new Date().toISOString().split('T')[0]; }

function initMassUpload() {
  document.querySelectorAll('.mtab-btn').forEach(b => {
    if (!b.dataset.mtab) return;
    b.addEventListener('click', () => {
      document.querySelectorAll('.mtab-btn').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.mtab-content').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      document.getElementById('mtab-' + b.dataset.mtab).classList.add('active');
    });
  });

  const zone = document.getElementById('jsonUploadZone');
  const fi = document.getElementById('jsonFileInput');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('dragover'); if (e.dataTransfer.files[0]) handleJsonFile(e.dataTransfer.files[0]); });
  zone.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => { if (fi.files[0]) handleJsonFile(fi.files[0]); fi.value = ''; });

  document.getElementById('selectAllProducts').addEventListener('change', e => selectAll('product', e.target.checked));
  document.getElementById('selectAllDrafts').addEventListener('change', e => selectAll('draft', e.target.checked));
  document.getElementById('btnSaveDraft').addEventListener('click', saveSelectedToDrafts);
  document.getElementById('btnRemoveSelected').addEventListener('click', removeSelectedProducts);
  document.getElementById('btnScheduleSelected').addEventListener('click', () => openScheduleFromSelection('products'));
  document.getElementById('btnDeleteDrafts').addEventListener('click', deleteSelectedDrafts);
  document.getElementById('btnScheduleDrafts').addEventListener('click', () => openScheduleFromSelection('drafts'));
  ['massStartDate', 'massPerDay'].forEach(id => document.getElementById(id).addEventListener('input', updateMassEndDate));
  ['draftStartDate', 'draftPerDay'].forEach(id => document.getElementById(id).addEventListener('input', updateDraftEndDate));

  document.getElementById('massStartDate').value = todayStr();
  document.getElementById('draftStartDate').value = todayStr();
}

async function handleJsonFile(file) {
  const meta = document.getElementById('jsonMeta');
  try {
    const json = JSON.parse(await file.text());
    const products = Array.isArray(json) ? json : (json.products || []);
    if (!Array.isArray(products) || !products.length) throw new Error('Tidak ada array "products" di file');
    parsedProducts = products.map((p, i) => ({ ...p, _id: String(p.product_id || ('cp_' + i)) }));
    selectedProductIds.clear();
    document.getElementById('selectAllProducts').checked = false;
    meta.className = 'result-box info';
    const withLink = parsedProducts.filter(p => p.link_komisi || p.link_produk).length;
    meta.textContent = `Terbaca ${parsedProducts.length} produk (${withLink} punya link) dari ${file.name}.`;
    meta.style.display = 'block';
    renderProducts();
    toast(`${parsedProducts.length} produk dimuat`, 'success');
  } catch (e) {
    meta.className = 'result-box error';
    meta.textContent = 'Gagal membaca file: ' + e.message;
    meta.style.display = 'block';
  }
}

// ========== EXPORT CSV (Pinterest bulk upload) ==========
const CSV_COLUMNS = ['Title', 'Media URL', 'Pinterest board', 'Thumbnail', 'Description', 'Link', 'Publish date', 'Keywords'];

const CSV_TIMEZONES = [
  { id: 'Asia/Jakarta', label: 'WIB \u2014 Asia/Jakarta (UTC+7)', offset: 7 },
  { id: 'Asia/Makassar', label: 'WITA \u2014 Asia/Makassar (UTC+8)', offset: 8 },
  { id: 'Asia/Jayapura', label: 'WIT \u2014 Asia/Jayapura (UTC+9)', offset: 9 },
  { id: 'Asia/Singapore', label: 'SGT \u2014 Asia/Singapore (UTC+8)', offset: 8 },
  { id: 'Asia/Kuala_Lumpur', label: 'MYT \u2014 Kuala Lumpur (UTC+8)', offset: 8 },
  { id: 'UTC', label: 'UTC (UTC+0)', offset: 0 },
  { id: 'Europe/London', label: 'London (UTC+0)', offset: 0 },
  { id: 'America/Los_Angeles', label: 'US Pacific (UTC\u22127)', offset: -7 },
  { id: 'America/New_York', label: 'US Eastern (UTC\u22124)', offset: -4 }
];

function currentTimezone() {
  const id = (storeData.settings && storeData.settings.timezone) || 'Asia/Jakarta';
  return CSV_TIMEZONES.find(z => z.id === id) || CSV_TIMEZONES[0];
}

function csvPerDayVal() {
  const el = document.getElementById('csvPerDay');
  return Math.max(1, parseInt(el && el.value) || 1);
}

function csvEffectiveTimes(perDay) {
  per = Math.max(1, parseInt(perDay) || 1);
  const list = (storeData.settings && storeData.settings.postingTimes) || ['09:00'];
  const out = [];
  for (let i = 0; i < per; i++) out.push(list[i % list.length]);
  return out;
}

function updateCsvAddTimeState() {
  const btn = document.getElementById('csvAddTime');
  if (!btn) return;
  const per = csvPerDayVal();
  const atCap = (storeData.settings.postingTimes || []).length >= per;
  btn.classList.toggle('disabled', atCap);
  btn.title = atCap ? `Maksimal ${per} jam (sama dengan Posting per Hari)` : 'Tambah jam posting';
}

function initCsvExport() {
  const zone = document.getElementById('csvUploadZone');
  const fi = document.getElementById('csvFileInput');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('dragover'); if (e.dataTransfer.files[0]) handleCsvJsonFile(e.dataTransfer.files[0]); });
  zone.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => { if (fi.files[0]) handleCsvJsonFile(fi.files[0]); fi.value = ''; });

  // Export CSV tabs (Produk / Draft)
  document.querySelectorAll('.mtab-btn[data-ctab]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.mtab-btn[data-ctab]').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('#page-csv-export .mtab-content').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById('ctab-' + b.dataset.ctab).classList.add('active');
  }));

  document.getElementById('csvSelectAllProducts').addEventListener('change', e => selectAll('csvproduct', e.target.checked));
  document.getElementById('csvSelectAllDrafts').addEventListener('change', e => selectAll('csvdraft', e.target.checked));
  document.getElementById('csvBtnSaveDraft').addEventListener('click', csvSaveSelectedToDrafts);
  document.getElementById('csvBtnRemoveProducts').addEventListener('click', csvRemoveSelectedProducts);
  document.getElementById('csvBtnDeleteDrafts').addEventListener('click', csvDeleteSelectedDrafts);
  document.getElementById('btnGenerateCsv').addEventListener('click', generateCsvFile);
  document.getElementById('csvBoard').addEventListener('change', renderCsvPreview);
  document.getElementById('csvStartDate').addEventListener('input', () => { renderCsvTimesHint(); renderCsvPreview(); });
  document.getElementById('csvPerDay').addEventListener('input', () => {
    const per = csvPerDayVal();
    const times = storeData.settings.postingTimes;
    if (times.length > per) {
      storeData.settings.postingTimes = times.slice(0, per);
      saveSettings();
      renderCsvTimes();
      toast(`Master jam disesuaikan: maksimal ${per} jam (sama dengan Posting per Hari).`, 'info');
    }
    renderCsvTimesHint();
    renderCsvPreview();
  });
  document.getElementById('csvTimezone').addEventListener('change', e => {
    storeData.settings.timezone = e.target.value;
    saveSettings();
    renderCsvTimesHint();
    renderCsvPreview();
  });
  document.getElementById('csvAddTime').addEventListener('click', () => {
    if (!Array.isArray(storeData.settings.postingTimes)) storeData.settings.postingTimes = [];
    const per = csvPerDayVal();
    if (storeData.settings.postingTimes.length >= per) {
      toast(`Maksimal ${per} jam posting (sama dengan Posting per Hari). Naikkan "Posting per Hari" untuk menambah jam.`, 'error');
      return;
    }
    storeData.settings.postingTimes.push('12:00');
    saveSettings();
    renderCsvTimes();
    renderCsvTimesHint();
    renderCsvPreview();
  });

  renderCsvTimezoneSelect();
  renderCsvTimes();
}

async function handleCsvJsonFile(file) {
  const meta = document.getElementById('csvMeta');
  try {
    const json = JSON.parse(await file.text());
    const products = Array.isArray(json) ? json : (json.products || []);
    if (!Array.isArray(products) || !products.length) throw new Error('Tidak ada array "products" di file');
    csvProducts = products.map((p, i) => ({ ...p, _id: String(p.product_id || ('cp_' + i)) }));
    selectedCsvProductIds.clear();
    const sa = document.getElementById('csvSelectAllProducts'); if (sa) sa.checked = false;
    meta.className = 'result-box info';
    const withImg = csvProducts.filter(p => (p.images && p.images[0]) || p.image).length;
    meta.textContent = `Terbaca ${csvProducts.length} produk (${withImg} punya gambar) dari ${file.name}. Pilih produk lalu simpan ke draft, atau langsung atur detail di bawah.`;
    meta.style.display = 'block';
    const ptab = document.querySelector('.mtab-btn[data-ctab="products"]'); if (ptab) ptab.click();
    renderCsvProducts();
    toast(`${csvProducts.length} produk dimuat`, 'success');
  } catch (e) {
    csvProducts = [];
    selectedCsvProductIds.clear();
    meta.className = 'result-box error';
    meta.textContent = 'Gagal membaca file: ' + e.message;
    meta.style.display = 'block';
    renderCsvProducts();
  }
}

function clipText(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }

function csvBoardName() {
  const sel = document.getElementById('csvBoard');
  if (sel && sel.value) {
    const opt = sel.options[sel.selectedIndex];
    const name = opt && opt.textContent ? opt.textContent.replace(/\s*\(default\)\s*$/, '').trim() : '';
    if (name && name !== 'Board default') return name;
    const byId = boardNameById(sel.value);
    if (byId) return byId;
  }
  return (boards && boards[0] && boards[0].name) || '';
}

// Products/drafts currently feeding the CSV: selected drafts > selected products > all products > all drafts.
function csvSourceItems() {
  if (selectedCsvDraftIds.size) return storeData.drafts.filter(d => selectedCsvDraftIds.has(d.id));
  if (selectedCsvProductIds.size) return csvProducts.filter(p => selectedCsvProductIds.has(p._id));
  if (csvProducts.length) return csvProducts;
  return storeData.drafts;
}

function csvPublishDate(startDate, perDay, index) {
  if (!startDate) return '';
  const per = Math.max(1, parseInt(perDay) || 1);
  const times = csvEffectiveTimes(per);
  const hm = String(times[index % per] || '09:00').split(':');
  const dayOffset = Math.floor(index / per);
  const [Y, M, D] = String(startDate).split('-').map(Number);
  const tz = currentTimezone();
  const utcMs = Date.UTC(Y, (M || 1) - 1, (D || 1) + dayOffset, parseInt(hm[0]) || 0, parseInt(hm[1]) || 0, 0) - tz.offset * 3600000;
  const d = new Date(utcMs);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function csvEscape(v) {
  v = v == null ? '' : String(v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function updateCsvEndDate() {
  const el = document.getElementById('csvEndDate');
  if (!el) return;
  const start = document.getElementById('csvStartDate').value;
  const per = parseInt(document.getElementById('csvPerDay').value) || 1;
  const items = csvSourceItems();
  el.value = start && items.length ? computeEndDate(start, per, items.length) : '';
}

function renderCsvPreview() {
  const btn = document.getElementById('btnGenerateCsv');
  const prev = document.getElementById('csvPreview');
  if (!btn) return;
  const items = csvSourceItems();
  btn.disabled = !items.length;
  if (!items.length) { prev.textContent = 'Belum ada file diunggah.'; updateCsvEndDate(); return; }
  const src = selectedCsvDraftIds.size ? `${selectedCsvDraftIds.size} draft terpilih`
    : selectedCsvProductIds.size ? `${selectedCsvProductIds.size} produk terpilih`
    : csvProducts.length ? `${csvProducts.length} produk`
    : `${storeData.drafts.length} draft`;
  const noImg = items.filter(p => !((p.images && p.images[0]) || p.image)).length;
  const per = parseInt(document.getElementById('csvPerDay').value) || 1;
  const tz = currentTimezone();
  const parts = [`${items.length} item (${src})`];
  if (noImg) parts.push(`${noImg} tanpa gambar`);
  parts.push('board: ' + (csvBoardName() || '(belum dipilih!)'));
  parts.push(`${per}/hari @ ${csvEffectiveTimes(per).join(', ')} ${tz.label.match(/\(([^)]+)\)/)?.[1] || tz.id}`);
  prev.textContent = parts.join(' \u2022 ');
  updateCsvEndDate();
}

function buildCsv() {
  const board = csvBoardName();
  const per = parseInt(document.getElementById('csvPerDay').value) || 1;
  const start = document.getElementById('csvStartDate').value;
  const keywords = document.getElementById('csvKeywords').value.trim();
  const lines = [CSV_COLUMNS.join(',')];
  csvSourceItems().forEach((p, i) => {
    const title = clipText(p.nama_produk || p.title || '', 100);
    const media = (p.images && p.images[0]) || p.image || '';
    const desc = clipText(p.description || p.nama_produk || p.title || '', 500);
    const link = p.link_komisi || p.link_produk || p.affiliateLink || p.productLink || '';
    const pub = start ? csvPublishDate(start, per, i) : '';
    lines.push([title, media, board, '', desc, link, pub, keywords].map(csvEscape).join(','));
  });
  return lines.join('\r\n') + '\r\n';
}

function generateCsvFile() {
  const items = csvSourceItems();
  if (!items.length) { toast('Unggah file JSON atau pilih draft dulu', 'error'); return; }
  if (!csvBoardName()) { toast('Pilih board tujuan dulu', 'error'); return; }
  const unix = Math.floor(Date.now() / 1000);
  const filename = `shopee_${unix}.csv`;
  const blob = new Blob([buildCsv()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`CSV dibuat: ${filename} (${items.length} baris)`, 'success');
}

// ===== Export CSV: products + drafts =====
function renderCsvProducts() {
  const section = document.getElementById('csvProductsSection');
  const list = document.getElementById('csvProductsList');
  if (!section) return;
  selectedCsvProductIds = new Set([...selectedCsvProductIds].filter(id => csvProducts.some(p => p._id === id)));
  const tc = document.getElementById('csvProductsTabCount'); if (tc) tc.textContent = csvProducts.length;
  if (!csvProducts.length) { section.style.display = 'none'; renderCsvPreview(); return; }
  section.style.display = 'block';
  const c = document.getElementById('csvProductsCount'); if (c) c.textContent = csvProducts.length;
  list.innerHTML = csvProducts.map(p => productRow(p, selectedCsvProductIds.has(p._id), 'csvproduct')).join('');
  renderCsvPreview();
}

function renderCsvDrafts() {
  const list = document.getElementById('csvDraftsList');
  const countEl = document.getElementById('csvDraftsCount');
  const tabEl = document.getElementById('csvDraftsTabCount');
  if (countEl) countEl.textContent = storeData.drafts.length;
  if (tabEl) tabEl.textContent = storeData.drafts.length;
  if (!list) return;
  selectedCsvDraftIds = new Set([...selectedCsvDraftIds].filter(id => storeData.drafts.some(d => d.id === id)));
  if (!storeData.drafts.length) { list.innerHTML = '<div class="keys-loading">Belum ada draft</div>'; return; }
  list.innerHTML = storeData.drafts.map(d => productRow(d, selectedCsvDraftIds.has(d.id), 'csvdraft')).join('');
}

async function csvSaveSelectedToDrafts() {
  if (!selectedCsvProductIds.size) { toast('Pilih produk dulu', 'error'); return; }
  const items = csvProducts.filter(p => selectedCsvProductIds.has(p._id));
  try {
    const r = await fetch('/api/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
    const d = await r.json();
    storeData.drafts = d.drafts || storeData.drafts;
  } catch (e) { toast('Gagal menyimpan draft: ' + e.message, 'error'); return; }
  selectedCsvProductIds.clear();
  const sa = document.getElementById('csvSelectAllProducts'); if (sa) sa.checked = false;
  renderCsvProducts();
  renderCsvDrafts();
  const dtab = document.querySelector('.mtab-btn[data-ctab="drafts"]'); if (dtab) dtab.click();
  toast(`${items.length} produk disimpan ke draft`, 'success');
}

function csvRemoveSelectedProducts() {
  if (!selectedCsvProductIds.size) { toast('Pilih produk dulu', 'error'); return; }
  csvProducts = csvProducts.filter(p => !selectedCsvProductIds.has(p._id));
  selectedCsvProductIds.clear();
  const sa = document.getElementById('csvSelectAllProducts'); if (sa) sa.checked = false;
  renderCsvProducts();
}

async function csvDeleteSelectedDrafts() {
  if (!selectedCsvDraftIds.size) { toast('Pilih draft dulu', 'error'); return; }
  if (!confirm(`Hapus ${selectedCsvDraftIds.size} draft?`)) return;
  try {
    const r = await fetch('/api/drafts/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...selectedCsvDraftIds] }) });
    const d = await r.json();
    storeData.drafts = d.drafts || [];
  } catch (e) { toast('Gagal menghapus: ' + e.message, 'error'); return; }
  selectedCsvDraftIds.clear();
  const sa = document.getElementById('csvSelectAllDrafts'); if (sa) sa.checked = false;
  renderCsvDrafts();
  renderDrafts();
  toast('Draft dihapus', 'success');
}

// ===== Master posting times + timezone =====
function renderCsvTimezoneSelect() {
  const sel = document.getElementById('csvTimezone');
  if (!sel) return;
  const tz = (storeData.settings && storeData.settings.timezone) || 'Asia/Jakarta';
  sel.innerHTML = CSV_TIMEZONES.map(z => `<option value="${z.id}" ${z.id === tz ? 'selected' : ''}>${escapeHtml(z.label)}</option>`).join('');
}

function renderCsvTimes() {
  const box = document.getElementById('csvTimesList');
  if (!box) return;
  if (!Array.isArray(storeData.settings.postingTimes) || !storeData.settings.postingTimes.length) storeData.settings.postingTimes = ['09:00'];
  box.innerHTML = storeData.settings.postingTimes.map((t, i) =>
    `<div class="mtimes-row"><input type="time" value="${escapeHtml(t)}" data-idx="${i}"><button type="button" class="mtimes-del" data-idx="${i}" title="Hapus">\u2715</button></div>`
  ).join('');
  box.querySelectorAll('input[type="time"]').forEach(inp => inp.addEventListener('input', () => {
    storeData.settings.postingTimes[parseInt(inp.dataset.idx)] = inp.value;
    saveSettings();
    renderCsvTimesHint();
    renderCsvPreview();
  }));
  box.querySelectorAll('.mtimes-del').forEach(btn => btn.addEventListener('click', () => {
    storeData.settings.postingTimes.splice(parseInt(btn.dataset.idx), 1);
    if (!storeData.settings.postingTimes.length) storeData.settings.postingTimes = ['09:00'];
    saveSettings();
    renderCsvTimes();
    renderCsvTimesHint();
    renderCsvPreview();
  }));
  updateCsvAddTimeState();
  renderCsvTimesHint();
}

function renderCsvTimesHint() {
  const hint = document.getElementById('csvTimesHint');
  if (!hint) return;
  const per = csvPerDayVal();
  const eff = csvEffectiveTimes(per);
  const tz = currentTimezone();
  const sign = tz.offset >= 0 ? '\u2212' : '+';
  const n = (storeData.settings.postingTimes || []).length;
  const cap = n >= per ? ` (maksimal ${per} jam)` : '';
  hint.textContent = `${per} posting/hari: ${eff.join(', ')}${cap} • ${n} jam master (${tz.label}). Publish date di CSV ditulis dalam UTC (jam lokal ${sign} ${Math.abs(tz.offset)} jam).`;
}

async function saveSettings() {
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: storeData.settings.timezone, postingTimes: storeData.settings.postingTimes })
    });
  } catch (e) { /* non-fatal */ }
}

function renderProducts() {
  const section = document.getElementById('productsSection');
  const list = document.getElementById('productsList');
  selectedProductIds = new Set([...selectedProductIds].filter(id => parsedProducts.some(p => p._id === id)));
  if (!parsedProducts.length) { section.style.display = 'none'; updateMassCounts(); return; }
  section.style.display = 'block';
  document.getElementById('productsCount').textContent = parsedProducts.length;
  list.innerHTML = parsedProducts.map(p => productRow(p, selectedProductIds.has(p._id), 'product')).join('');
  updateMassCounts();
}

function productRow(p, checked, kind) {
  const id = escapeHtml(String(p._id || p.id));
  const img = p.image || (p.images && p.images[0]) || '';
  const title = p.title || p.nama_produk || '(tanpa judul)';
  const price = p.price || p.harga || '';
  const sales = p.sales || p.penjualan || '';
  const commission = p.commission || p.komisi || '';
  const store = p.store || p.nama_toko || '';
  const productLink = p.productLink || p.link_produk || '';
  const affiliateLink = p.affiliateLink || p.link_komisi || '';
  const links = [
    productLink ? `<a href="${escapeHtml(productLink)}" target="_blank" rel="noopener">Produk</a>` : '',
    affiliateLink ? `<a href="${escapeHtml(affiliateLink)}" target="_blank" rel="noopener">Link Affiliate</a>` : ''
  ].join('');
  return `<div class="product-item ${checked ? 'selected' : ''}" data-kind="${kind}" data-id="${id}">
    <input type="checkbox" class="row-check" ${checked ? 'checked' : ''} onchange="toggleSelect('${kind}','${id}',this.checked)">
    <div class="product-thumb" data-url="${escapeHtml(img)}" data-title="${escapeHtml(title)}" onclick="zoomThumb(this)">${img ? `<img src="${escapeHtml(img)}" loading="lazy" onerror="this.style.display='none'">` : '&#128204;'}</div>
    <div class="product-body">
      <div class="product-title">${escapeHtml(title)}</div>
      <div class="product-meta">
        ${price ? `<span class="product-price">Rp${escapeHtml(price)}</span>` : ''}
        ${sales ? `<span>${escapeHtml(sales)}</span>` : ''}
        ${commission ? `<span class="product-commission">${escapeHtml(commission)}</span>` : ''}
        ${store ? `<span>${escapeHtml(store)}</span>` : ''}
      </div>
      <div class="product-links">${links}</div>
    </div>
  </div>`;
}

function selectCtx(kind) {
  switch (kind) {
    case 'product': return { set: selectedProductIds, items: () => parsedProducts, idOf: it => it._id, update: updateMassCounts, render: renderProducts };
    case 'draft': return { set: selectedDraftIds, items: () => storeData.drafts, idOf: it => it.id, update: updateDraftCounts, render: renderDrafts };
    case 'csvproduct': return { set: selectedCsvProductIds, items: () => csvProducts, idOf: it => it._id, update: renderCsvPreview, render: renderCsvProducts };
    case 'csvdraft': return { set: selectedCsvDraftIds, items: () => storeData.drafts, idOf: it => it.id, update: renderCsvPreview, render: renderCsvDrafts };
    default: return null;
  }
}

function toggleSelect(kind, id, checked) {
  const ctx = selectCtx(kind);
  if (!ctx) return;
  if (checked) ctx.set.add(id); else ctx.set.delete(id);
  const row = document.querySelector(`.product-item[data-kind="${kind}"][data-id="${id}"]`);
  if (row) row.classList.toggle('selected', checked);
  ctx.update();
}

function selectAll(kind, checked) {
  const ctx = selectCtx(kind);
  if (!ctx) return;
  ctx.set.clear();
  ctx.items().forEach(it => { if (checked) ctx.set.add(String(ctx.idOf(it))); });
  ctx.render();
  ctx.update();
}

function updateMassCounts() {
  document.getElementById('massSelectedCount').textContent = selectedProductIds.size;
  document.getElementById('massActionBar').style.display = parsedProducts.length ? 'block' : 'none';
  updateMassEndDate();
}

function updateDraftCounts() {
  document.getElementById('draftSelectedCount').textContent = selectedDraftIds.size;
  document.getElementById('draftActionBar').style.display = storeData.drafts.length ? 'block' : 'none';
  updateDraftEndDate();
}

function computeEndDate(start, perDay, count) {
  perDay = Math.max(1, parseInt(perDay) || 1);
  if (!start || !count) return '';
  const parts = String(start).split('-').map(Number);
  const d = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
  d.setDate(d.getDate() + Math.floor((count - 1) / perDay));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function updateMassEndDate() {
  document.getElementById('massEndDate').value = computeEndDate(
    document.getElementById('massStartDate').value,
    document.getElementById('massPerDay').value,
    selectedProductIds.size);
}

function updateDraftEndDate() {
  document.getElementById('draftEndDate').value = computeEndDate(
    document.getElementById('draftStartDate').value,
    document.getElementById('draftPerDay').value,
    selectedDraftIds.size);
}

async function saveSelectedToDrafts() {
  const items = parsedProducts.filter(p => selectedProductIds.has(p._id));
  if (!items.length) { toast('Pilih produk dulu', 'error'); return; }
  try {
    const r = await fetch('/api/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    toast(`Ditambahkan ${d.added} draft${d.skipped ? `, ${d.skipped} duplikat dilewati` : ''}`, 'success');
    await loadStore();
    renderDrafts();
  } catch(e) { toast('Gagal: ' + e.message, 'error'); }
}

function removeSelectedProducts() {
  if (!selectedProductIds.size) { toast('Pilih produk dulu', 'error'); return; }
  parsedProducts = parsedProducts.filter(p => !selectedProductIds.has(p._id));
  selectedProductIds.clear();
  document.getElementById('selectAllProducts').checked = false;
  renderProducts();
  toast('Dihapus dari list', 'success');
}

async function deleteSelectedDrafts() {
  if (!selectedDraftIds.size) { toast('Pilih draft dulu', 'error'); return; }
  if (!confirm(`Hapus ${selectedDraftIds.size} draft?`)) return;
  try {
    const r = await fetch('/api/drafts/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...selectedDraftIds] }) });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    selectedDraftIds.clear();
    storeData.drafts = d.drafts || [];
    document.getElementById('selectAllDrafts').checked = false;
    renderDrafts();
    toast(`Dihapus ${d.removed} draft`, 'success');
  } catch(e) { toast('Gagal: ' + e.message, 'error'); }
}

// ========== DRAFTS ==========
async function loadStore() {
  try {
    const r = await fetch('/api/store');
    const d = await r.json();
    storeData.drafts = Array.isArray(d.drafts) ? d.drafts : [];
    storeData.schedules = Array.isArray(d.schedules) ? d.schedules : [];
    if (d.settings && typeof d.settings === 'object') storeData.settings = d.settings;
    if (!storeData.settings || typeof storeData.settings !== 'object') storeData.settings = { ...DEFAULT_SETTINGS, postingTimes: [...DEFAULT_SETTINGS.postingTimes] };
    if (!Array.isArray(storeData.settings.postingTimes) || !storeData.settings.postingTimes.length) storeData.settings.postingTimes = [...DEFAULT_SETTINGS.postingTimes];
    if (!storeData.settings.timezone) storeData.settings.timezone = DEFAULT_SETTINGS.timezone;
  } catch(e) { console.error('store', e); }
  renderDrafts();
  renderCsvDrafts();
  renderCsvTimezoneSelect();
  renderCsvTimes();
  renderSchedules();
  renderScheduleCalendar();
}

function renderDrafts() {
  const list = document.getElementById('draftsList');
  const count = storeData.drafts.length;
  document.getElementById('draftsCount').textContent = count;
  document.getElementById('draftTabCount').textContent = count;
  selectedDraftIds = new Set([...selectedDraftIds].filter(id => storeData.drafts.some(d => d.id === id)));
  if (!count) { list.innerHTML = '<div class="keys-loading">Belum ada draft</div>'; updateDraftCounts(); return; }
  list.innerHTML = storeData.drafts.map(d => productRow(d, selectedDraftIds.has(d.id), 'draft')).join('');
  updateDraftCounts();
}

// ========== IMAGE ZOOM ==========
function zoomThumb(el) { zoomImageUrl(el.dataset.url, el.dataset.title); }
function zoomImageUrl(url, title) {
  if (!url) return;
  const im = document.getElementById('imageZoomImg');
  im.src = url; im.alt = title || '';
  document.getElementById('imageZoomInfo').textContent = title || '';
  document.getElementById('imageZoomModal').style.display = 'flex';
}
function closeImageZoom() {
  document.getElementById('imageZoomModal').style.display = 'none';
  document.getElementById('imageZoomImg').src = '';
}

// ========== SCHEDULING ==========
function boardNameById(id) { const b = boards.find(x => String(x.id) === String(id)); return b ? b.name : ''; }

function openScheduleFromSelection(source) {
  const items = source === 'products'
    ? parsedProducts.filter(p => selectedProductIds.has(p._id))
    : storeData.drafts.filter(d => selectedDraftIds.has(d.id));
  if (!items.length) { toast('Pilih item dulu', 'error'); return; }
  const prefix = source === 'products' ? 'mass' : 'draft';
  const boardId = document.getElementById(prefix + 'Board').value;
  const perDay = Math.max(1, parseInt(document.getElementById(prefix + 'PerDay').value) || 1);
  const startDate = document.getElementById(prefix + 'StartDate').value;
  if (!startDate) { toast('Pilih tanggal mulai', 'error'); return; }
  scheduleSource = { source, items, boardId, perDay, startDate };
  const endDate = computeEndDate(startDate, perDay, items.length);
  document.getElementById('scheduleName').value = '';
  document.getElementById('scheduleError').style.display = 'none';
  document.getElementById('scheduleSummary').innerHTML = `
    <div class="row"><span>Jumlah pin</span><span>${items.length}</span></div>
    <div class="row"><span>Posting per hari</span><span>${perDay}</span></div>
    <div class="row"><span>Tanggal mulai</span><span>${startDate}</span></div>
    <div class="row"><span>Tanggal selesai</span><span>${endDate}</span></div>
    <div class="row"><span>Board</span><span>${escapeHtml(boardNameById(boardId) || 'Board default')}</span></div>`;
  document.getElementById('scheduleModal').style.display = 'flex';
}

function closeScheduleModal() { document.getElementById('scheduleModal').style.display = 'none'; }

async function confirmSchedule() {
  if (!scheduleSource) return;
  const btn = document.getElementById('btnConfirmSchedule');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    const r = await fetch('/api/schedules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('scheduleName').value.trim(),
        accountId: currentAccountId,
        boardId: scheduleSource.boardId,
        postsPerDay: scheduleSource.perDay,
        startDate: scheduleSource.startDate,
        items: scheduleSource.items
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(typeof d.error === 'string' ? d.error : JSON.stringify(d.error));
    closeScheduleModal();
    if (scheduleSource.source === 'products') { selectedProductIds.clear(); document.getElementById('selectAllProducts').checked = false; renderProducts(); }
    await loadStore();
    toast('Penjadwalan disimpan', 'success');
    switchPage('schedule');
  } catch(e) {
    const eb = document.getElementById('scheduleError');
    eb.textContent = e.message; eb.style.display = 'block';
  } finally { btn.disabled = false; btn.textContent = 'Simpan Penjadwalan'; }
}

// ========== SCHEDULE PAGE ==========
function initSchedule() {
  document.getElementById('btnConfirmSchedule').addEventListener('click', confirmSchedule);
  document.getElementById('btnDetailPublish').addEventListener('click', () => { if (schDetailId) publishSchedule(schDetailId); });
  document.getElementById('scheduleModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeScheduleModal(); });
  document.getElementById('scheduleDetailModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeScheduleDetail(); });
  document.getElementById('imageZoomModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeImageZoom(); });
}

async function loadSchedules() { await loadStore(); await loadRemoteScheduled(); }

function statusLabel(s) {
  return { scheduled: 'Terjadwal', published: 'Published', partial: 'Sebagian', failed: 'Gagal' }[s] || s;
}

function renderSchedules() {
  const list = document.getElementById('schedulesList');
  if (!list) return;
  const schedules = storeData.schedules || [];
  document.getElementById('schedulesCount').textContent = schedules.length;
  if (!schedules.length) { list.innerHTML = '<div class="keys-loading">Belum ada penjadwalan</div>'; return; }
  list.innerHTML = schedules.map(s => {
    const total = s.items.length;
    const published = s.items.filter(i => i.publishStatus === 'published').length;
    const badgeCls = s.status === 'published' ? 'connected' : s.status === 'failed' ? 'error' : 'default';
    return `<div class="key-card">
      <div class="key-card-top">
        <span class="key-card-badge ${badgeCls}">${escapeHtml(statusLabel(s.status))}</span>
        <span class="key-card-badge default">${published}/${total} published</span>
      </div>
      <div class="key-card-name">${escapeHtml(s.name)}</div>
      <div class="key-card-fans">${s.startDate} &#8594; ${s.endDate} &bull; ${s.postsPerDay}/hari &bull; ${total} pin</div>
      <div class="key-card-details">
        <span class="key-card-code">${escapeHtml(boardNameById(s.boardId) || 'Board default')}</span>
        <div class="key-card-actions">
          <button class="key-card-btn" onclick="viewSchedule('${s.id}')">Detail</button>
          <button class="key-card-btn publish" onclick="publishSchedule('${s.id}')">Publish</button>
          <button class="key-card-btn" onclick="deleteSchedule('${s.id}')">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function flattenScheduleItems() {
  const out = [];
  (storeData.schedules || []).forEach(s => (s.items || []).forEach(it => out.push({
    title: it.title, scheduledFor: it.scheduledFor, publishStatus: it.publishStatus, scheduleName: s.name,
    postId: it.postId, image: it.image || (it.images && it.images[0]) || ''
  })));
  return out;
}

// Pins already scheduled on Pinterest (fetched from Zernio).
function remoteScheduleItems() {
  return remoteScheduledPosts.map(p => ({
    title: p.title || p.content || '(pin)',
    scheduledFor: p.scheduledFor || p.publishDate || p.scheduledAt || p.createdAt || '',
    publishStatus: 'scheduled',
    remote: true,
    postId: p._id || p.id || '',
    image: (p.mediaItems && p.mediaItems[0] && (p.mediaItems[0].url || p.mediaItems[0].thumbnailUrl)) || p.image || ''
  }));
}

// Local schedule items + remote Pinterest-scheduled pins, de-duplicated by postId.
function scheduleCalendarItems() {
  const remote = remoteScheduleItems();
  const remoteIds = new Set(remote.map(r => String(r.postId)).filter(Boolean));
  const local = flattenScheduleItems().filter(it => !it.postId || !remoteIds.has(String(it.postId)));
  return [...local, ...remote];
}

async function loadRemoteScheduled() {
  try {
    const url = `/api/posts?platform=pinterest&source=zernio&limit=100${currentAccountId ? `&accountId=${currentAccountId}` : ''}`;
    const r = await fetch(url);
    const d = await r.json();
    const posts = d.posts || [];
    remoteScheduledPosts = posts.filter(p => (p.status || p.state || '').toLowerCase() === 'scheduled');
  } catch (e) { remoteScheduledPosts = []; }
  renderScheduleCalendar();
  renderRemoteSchedules();
}

function renderRemoteSchedules() {
  const list = document.getElementById('remoteSchedulesList');
  if (!list) return;
  const countEl = document.getElementById('remoteSchedulesCount');
  if (countEl) countEl.textContent = remoteScheduledPosts.length;
  if (!remoteScheduledPosts.length) { list.innerHTML = '<div class="keys-loading">Belum ada pin terjadwal di Pinterest</div>'; return; }
  list.innerHTML = remoteScheduledPosts.map(p => {
    const when = p.scheduledFor || p.publishDate || p.scheduledAt || '';
    const img = (p.mediaItems && p.mediaItems[0] && (p.mediaItems[0].url || p.mediaItems[0].thumbnailUrl)) || p.image || '';
    const title = p.title || p.content || '(pin)';
    return `<div class="key-card">
      <div class="key-card-top"><span class="key-card-badge default">Terjadwal</span></div>
      <div class="key-card-name">${escapeHtml(String(title).substring(0, 90))}</div>
      <div class="key-card-fans">${fmtDate(when)}${img ? '' : ' &bull; tanpa gambar'}</div>
    </div>`;
  }).join('');
}

function localSchedulePosts() {
  return flattenScheduleItems().filter(it => it.publishStatus !== 'published').map(it => ({
    title: it.title || '(pin)', content: it.title || '', scheduledFor: it.scheduledFor, status: 'scheduled', local: true
  }));
}

function renderScheduleCalendar() {
  const grid = document.getElementById('scheduleCalendarGrid');
  if (!grid) return;
  const months = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  document.getElementById('schCalMonthLabel').textContent = `${months[schCalMonth]} ${schCalYear}`;
  const items = scheduleCalendarItems();
  const firstDay = new Date(schCalYear, schCalMonth, 1).getDay();
  const daysInMonth = new Date(schCalYear, schCalMonth + 1, 0).getDate();
  const todayStr2 = todayStr();
  const dayNames = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
  let html = dayNames.map(d => `<div class="cal-header">${d}</div>`).join('');
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-day empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${schCalYear}-${String(schCalMonth + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dayItems = items.filter(it => (it.scheduledFor || '').startsWith(dateStr));
    const cls = ['cal-day'];
    if (dateStr === todayStr2) cls.push('today');
    if (dayItems.length) cls.push('has-post');
    let tooltip = '';
    if (dayItems.length) {
      tooltip = '<div class="cal-tooltip">' + dayItems.slice(0, 6).map(it => {
        const st = it.publishStatus === 'published' ? '&#10003;' : it.publishStatus === 'failed' ? '&#10007;' : '&#9200;';
        return `<div class="cal-tooltip-item">${st} ${escapeHtml(it.title || '(pin)').substring(0, 40)}</div>`;
      }).join('') + (dayItems.length > 6 ? `<div class="cal-tooltip-item">+${dayItems.length - 6} lagi...</div>` : '') + '</div>';
    }
    html += `<div class="${cls.join(' ')}"><div class="day-num">${d}</div>${dayItems.length ? `<div class="cal-post-count">${dayItems.length} pin</div>` : ''}${tooltip}</div>`;
  }
  grid.innerHTML = html;
}

function schCalPrev() { schCalMonth--; if (schCalMonth < 0) { schCalMonth = 11; schCalYear--; } renderScheduleCalendar(); }
function schCalNext() { schCalMonth++; if (schCalMonth > 11) { schCalMonth = 0; schCalYear++; } renderScheduleCalendar(); }

function viewSchedule(id) {
  const s = storeData.schedules.find(x => x.id === id);
  if (!s) return;
  schDetailId = id;
  document.getElementById('schDetailTitle').textContent = s.name;
  document.getElementById('schDetailMeta').textContent =
    `${s.startDate} \u2192 ${s.endDate} \u2022 ${s.postsPerDay}/hari \u2022 ${s.items.length} pin \u2022 ${boardNameById(s.boardId) || 'Board default'}`;
  document.getElementById('schDetailList').innerHTML = s.items.map(it => {
    const img = it.image || (it.images && it.images[0]) || '';
    const st = it.publishStatus || 'pending';
    return `<div class="sch-detail-item">
      <div class="product-thumb" style="width:40px;height:40px;cursor:zoom-in" data-url="${escapeHtml(img)}" data-title="${escapeHtml(it.title || '')}" onclick="zoomThumb(this)">${img ? `<img src="${escapeHtml(img)}" loading="lazy">` : '&#128204;'}</div>
      <div class="sch-detail-info">
        <div class="sch-detail-title">${escapeHtml(it.title || '')}</div>
        <div class="sch-detail-sub">${fmtDate(it.scheduledFor)}${it.postId ? ' \u2022 ' + escapeHtml(String(it.postId)) : ''}${it.publishError ? ' \u2022 ' + escapeHtml(it.publishError) : ''}</div>
      </div>
      <span class="sch-badge ${st === 'published' ? 'published' : st === 'failed' ? 'failed' : 'pending'}">${st}</span>
    </div>`;
  }).join('');
  document.getElementById('scheduleDetailModal').style.display = 'flex';
}

function closeScheduleDetail() {
  document.getElementById('scheduleDetailModal').style.display = 'none';
  schDetailId = null;
}

async function publishSchedule(id) {
  const s = storeData.schedules.find(x => x.id === id);
  if (!s) return;
  if (!confirm(`Publish ${s.items.length} pin ke Zernio?`)) return;
  const overlay = document.getElementById('switchOverlay');
  document.getElementById('overlayText').textContent = `Mempublish ${s.items.length} pin...`;
  overlay.style.display = 'flex';
  try {
    const r = await fetch(`/api/schedules/${id}/publish`, { method: 'POST' });
    const d = await r.json();
    if (d.accountIssue) {
      overlay.style.display = 'none';
      showAccountBanner(d);
      toast('Akun bermasalah: ' + (d.error || 'tidak bisa publish'), 'error');
      return;
    }
    if (d.error) throw new Error(typeof d.error === 'string' ? d.error : JSON.stringify(d.error));
    await loadStore();
    await loadRemoteScheduled();
    toast(`Publish selesai: ${d.ok} OK, ${d.failed} gagal`, d.failed ? 'error' : 'success');
    if (schDetailId === id) viewSchedule(id);
  } catch(e) { toast('Gagal publish: ' + e.message, 'error'); }
  overlay.style.display = 'none';
}

async function deleteSchedule(id) {
  if (!confirm('Hapus penjadwalan ini?')) return;
  try {
    const r = await fetch(`/api/schedules/${id}`, { method: 'DELETE' });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    await loadStore();
    toast('Penjadwalan dihapus', 'success');
  } catch(e) { toast('Gagal: ' + e.message, 'error'); }
}
