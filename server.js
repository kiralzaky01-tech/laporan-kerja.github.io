/**
 * ═══════════════════════════════════════════════════════════════
 *  LAPORAN KERJA — Backend Server
 *  Jalankan: node server.js
 *  Akses UI : http://localhost:3000
 * ═══════════════════════════════════════════════════════════════
 */

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const url     = require('url');

// ── CONFIG ──────────────────────────────────────────────────────
// Edit bagian ini sesuai akun GitHub Anda
const CONFIG = {
  PORT        : 3000,
  DATA_FILE   : path.join(__dirname, 'data.json'),
  LOG_FILE    : path.join(__dirname, 'sync.log'),

  // === KONFIGURASI GITHUB — ISI SEKALI SAJA ===
  GITHUB_TOKEN : process.env.GITHUB_TOKEN || 'GANTI_DENGAN_TOKEN_ANDA',
  GITHUB_OWNER : process.env.GITHUB_OWNER || 'GANTI_DENGAN_USERNAME',
  GITHUB_REPO  : process.env.GITHUB_REPO  || 'GANTI_DENGAN_NAMA_REPO',
  GITHUB_PATH  : process.env.GITHUB_PATH  || 'data.json',
  GITHUB_BRANCH: process.env.GITHUB_BRANCH|| 'main',
  // ============================================

  AUTO_SYNC_INTERVAL_MS: 30 * 1000, // Auto sync ke GitHub setiap 30 detik jika ada perubahan
};

// ── STATE ────────────────────────────────────────────────────────
let pendingSync   = false;   // ada perubahan yang belum di-sync
let lastSyncTime  = null;
let syncStatus    = 'idle';  // 'idle' | 'syncing' | 'ok' | 'error'
let lastSyncMsg   = 'Belum pernah sync';

// ── HELPERS ──────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(CONFIG.LOG_FILE, line + '\n');
}

function readData() {
  if (!fs.existsSync(CONFIG.DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8')); }
  catch (e) { log('ERROR read data: ' + e.message); return []; }
}

function writeData(arr) {
  fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(arr, null, 2));
  pendingSync = true;
  log(`Data disimpan lokal (${arr.length} item)`);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ── GITHUB SYNC ───────────────────────────────────────────────────
function githubConfigured() {
  return (
    CONFIG.GITHUB_TOKEN !== 'GANTI_DENGAN_TOKEN_ANDA' &&
    CONFIG.GITHUB_OWNER !== 'GANTI_DENGAN_USERNAME' &&
    CONFIG.GITHUB_REPO  !== 'GANTI_DENGAN_NAMA_REPO' &&
    CONFIG.GITHUB_TOKEN.length > 10
  );
}

function githubRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path    : apiPath,
      method,
      headers : {
        'Authorization' : `token ${CONFIG.GITHUB_TOKEN}`,
        'Accept'        : 'application/vnd.github.v3+json',
        'User-Agent'    : 'LaporanKerja-Server/1.0',
        'Content-Type'  : 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function syncToGithub(forced = false) {
  if (!pendingSync && !forced) return;
  if (!githubConfigured()) {
    syncStatus = 'error';
    lastSyncMsg = 'GitHub belum dikonfigurasi di server.js';
    return;
  }

  syncStatus = 'syncing';
  log('Mulai sync ke GitHub...');

  try {
    const apiPath = `/repos/${CONFIG.GITHUB_OWNER}/${CONFIG.GITHUB_REPO}/contents/${CONFIG.GITHUB_PATH}`;

    // Cek SHA file yang ada
    let sha = null;
    const checkRes = await githubRequest('GET', apiPath + `?ref=${CONFIG.GITHUB_BRANCH}`);
    if (checkRes.status === 200) sha = checkRes.body.sha;

    // Encode konten
    const content  = fs.readFileSync(CONFIG.DATA_FILE, 'utf8');
    const encoded  = Buffer.from(content).toString('base64');
    const message  = `Auto-sync laporan kerja — ${new Date().toLocaleString('id-ID')}`;

    const putBody  = { message, content: encoded, branch: CONFIG.GITHUB_BRANCH };
    if (sha) putBody.sha = sha;

    const putRes = await githubRequest('PUT', apiPath, putBody);

    if (putRes.status === 200 || putRes.status === 201) {
      pendingSync  = false;
      lastSyncTime = new Date();
      syncStatus   = 'ok';
      lastSyncMsg  = `Berhasil sync ke GitHub pada ${lastSyncTime.toLocaleString('id-ID')}`;
      log('✅ Sync ke GitHub berhasil');
    } else {
      syncStatus  = 'error';
      lastSyncMsg = `GitHub error ${putRes.status}: ${putRes.body?.message || 'Unknown'}`;
      log('❌ Sync gagal: ' + lastSyncMsg);
    }
  } catch (e) {
    syncStatus  = 'error';
    lastSyncMsg = 'Koneksi ke GitHub gagal: ' + e.message;
    log('❌ ' + lastSyncMsg);
  }
}

// Auto-sync setiap interval
setInterval(() => { syncToGithub(); }, CONFIG.AUTO_SYNC_INTERVAL_MS);

// ── HTTP SERVER ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed  = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Preflight CORS
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // ── API ROUTES ──────────────────────────────────────────────────

  // GET /api/data — ambil semua data
  if (req.method === 'GET' && pathname === '/api/data') {
    return json(res, 200, { ok: true, data: readData() });
  }

  // POST /api/data — simpan semua data (replace)
  if (req.method === 'POST' && pathname === '/api/data') {
    try {
      const body = await readBody(req);
      if (!Array.isArray(body.data)) return json(res, 400, { ok: false, msg: 'data harus array' });
      writeData(body.data);
      return json(res, 200, { ok: true, msg: 'Tersimpan', count: body.data.length });
    } catch (e) {
      return json(res, 400, { ok: false, msg: e.message });
    }
  }

  // POST /api/sync — paksa sync ke GitHub sekarang
  if (req.method === 'POST' && pathname === '/api/sync') {
    pendingSync = true;
    syncToGithub(true).catch(() => {});
    return json(res, 200, { ok: true, msg: 'Sync dimulai...' });
  }

  // GET /api/status — status server + sync
  if (req.method === 'GET' && pathname === '/api/status') {
    return json(res, 200, {
      ok: true,
      server: 'running',
      syncStatus,
      lastSyncMsg,
      lastSyncTime : lastSyncTime ? lastSyncTime.toISOString() : null,
      pendingSync,
      githubConfigured: githubConfigured(),
      config: {
        owner : CONFIG.GITHUB_OWNER,
        repo  : CONFIG.GITHUB_REPO,
        path  : CONFIG.GITHUB_PATH,
        branch: CONFIG.GITHUB_BRANCH,
      },
    });
  }

  // ── SERVE FRONTEND HTML ──────────────────────────────────────────
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404); res.end('index.html tidak ditemukan');
    }
    return;
  }

  // 404
  json(res, 404, { ok: false, msg: 'Route tidak ditemukan' });
});

server.listen(CONFIG.PORT, () => {
  log(`\n${'═'.repeat(55)}`);
  log(`  🚀 Laporan Kerja Server berjalan`);
  log(`  📡 URL   : http://localhost:${CONFIG.PORT}`);
  log(`  📁 Data  : ${CONFIG.DATA_FILE}`);
  log(`  🐙 GitHub: ${githubConfigured()
    ? `${CONFIG.GITHUB_OWNER}/${CONFIG.GITHUB_REPO}/${CONFIG.GITHUB_PATH}`
    : '⚠ BELUM DIKONFIGURASI — edit CONFIG di server.js'}`);
  log(`  🔄 Auto-sync setiap ${CONFIG.AUTO_SYNC_INTERVAL_MS / 1000} detik`);
  log(`${'═'.repeat(55)}\n`);
});

process.on('SIGINT', async () => {
  log('\nServer berhenti — sync terakhir sebelum keluar...');
  if (pendingSync) await syncToGithub(true);
  process.exit(0);
});
