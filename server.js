'use strict';
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = Number(process.env.PORT || 3100);
const ADMIN_PASSWORD = process.env.IDI_ADMIN_PASSWORD || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_MS = 8 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const SOURCE_DATA_FILE = path.join(DATA_DIR, 'idi.json');
const STATE_FILE = path.join(DATA_DIR, 'idi-state.json');
const LEGACY_AUDIT_FILE = path.join(DATA_DIR, 'idi-audit.log');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads', 'idi');
const ASPECTS = new Set(['Kebebasan Sipil', 'Kesetaraan Politik', 'Lembaga Demokrasi']);
const sessions = new Map();
const loginAttempts = new Map();
const loginWindows = new Map();
let writeQueue = Promise.resolve();

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT harus berupa angka antara 1 dan 65535.');
if (IS_PRODUCTION) {
  if (ADMIN_PASSWORD.length < 16 || ADMIN_PASSWORD.startsWith('ganti_dengan_')) {
    throw new Error('Production requires IDI_ADMIN_PASSWORD with at least 16 characters.');
  }
  if (process.env.COOKIE_SECURE !== 'true') {
    throw new Error('Production requires COOKIE_SECURE=true behind HTTPS.');
  }
}
if (!ADMIN_PASSWORD) console.warn('[Peringatan] IDI_ADMIN_PASSWORD belum diatur; login admin dinonaktifkan.');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function validateDataset(data) {
  if (
    !data || !Number.isInteger(data.tahun) || !Number.isInteger(data.periodeData) ||
    !Array.isArray(data.aspek) || !Array.isArray(data.tren) || !Array.isArray(data.indikator) ||
    data.aspek.length === 0 || data.indikator.length === 0
  ) {
    throw new Error('File data E-IDI harus memiliki tahun, periode, aspek, tren, dan indikator yang valid.');
  }
  const aspectCodes = new Set(data.aspek.map((aspect) => aspect.kode));
  if (data.indikator.some((item) => !item.id || !aspectCodes.has(item.aspek))) {
    throw new Error('Setiap indikator harus memiliki ID dan mengacu ke aspek yang tersedia.');
  }
  return data;
}

function readLegacyAudit() {
  if (!fs.existsSync(LEGACY_AUDIT_FILE)) return [];
  return fs.readFileSync(LEGACY_AUDIT_FILE, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const [occurredAt, actorIp, action, ...detail] = line.split('\t');
    if (!occurredAt || !['TAMBAH', 'UBAH', 'HAPUS'].includes(action) || !detail.length) {
      throw new Error('Format log audit E-IDI lama tidak valid.');
    }
    if (Number.isNaN(Date.parse(occurredAt))) throw new Error('Waktu pada log audit E-IDI lama tidak valid.');
    return { occurredAt, actorIp: actorIp || '', action, detail: detail.join(' ') };
  });
}

function readAppState() {
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    validateDataset(state.dataset);
    if (!Array.isArray(state.audit)) throw new Error('Riwayat audit E-IDI tidak valid.');
    return state;
  }
  return { dataset: validateDataset(JSON.parse(fs.readFileSync(SOURCE_DATA_FILE, 'utf8'))), audit: readLegacyAudit() };
}

let appState = readAppState();

async function persistAppState(state) {
  const temporaryFile = `${STATE_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    await fs.promises.rename(temporaryFile, STATE_FILE);
  } catch (error) {
    try {
      await fs.promises.unlink(temporaryFile);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') console.error(`[Penyimpanan E-IDI] ${cleanupError.message}`);
    }
    throw error;
  }
}

function mutateDataset(req, action, detail, update) {
  const operation = writeQueue.then(async () => {
    const nextState = structuredClone(appState);
    const result = update(nextState.dataset);
    nextState.audit.push({
      occurredAt: new Date().toISOString(),
      actorIp: req.ip,
      action,
      detail: String(detail).replace(/[\t\r\n]+/g, ' ')
    });
    await persistAppState(nextState);
    appState = nextState;
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const item = part.trim();
    const index = item.indexOf('=');
    if (index > 0 && item.slice(0, index) === name) return decodeURIComponent(item.slice(index + 1));
  }
  return null;
}

function isAdmin(req) {
  const token = getCookie(req, 'idi_sid');
  const expiresAt = token && sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'Sesi admin berakhir. Silakan masuk kembali.' });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function safeEqual(actual, expected) {
  const actualHash = crypto.createHash('sha256').update(actual).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function setSessionCookie(res, token, maxAgeSeconds) {
  let value = `idi_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
  if (process.env.COOKIE_SECURE === 'true') value += '; Secure';
  res.setHeader('Set-Cookie', value);
}

function validScore(value) {
  const score = Math.round(Number(String(value).replace(',', '.')) * 100) / 100;
  return Number.isFinite(score) && score >= 0 && score <= 100 ? score : null;
}

function validateIndicator(body) {
  const aspect = String(body.aspek || '').trim();
  const indicator = String(body.indikator || '').trim().slice(0, 200);
  const notes = String(body.catatan || '').trim().slice(0, 1000);
  const score = validScore(body.skor);
  const errors = [];
  if (!ASPECTS.has(aspect)) errors.push('Pilih aspek IDI.');
  if (indicator.length < 3) errors.push('Nama indikator minimal 3 karakter.');
  if (score === null) errors.push('Skor harus antara 0 dan 100.');
  return { aspect, indicator, notes, score, errors };
}

function cleanName(value) {
  return String(value || '').replace(/[^\w .()\-]/g, '_').slice(0, 100);
}

function verifySignature(file) {
  const descriptor = fs.openSync(file.path, 'r');
  const header = Buffer.alloc(12);
  let count;
  try {
    count = fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (file.mimetype === 'application/pdf') return header.toString('ascii', 0, 5) === '%PDF-' && count >= 5;
  if (file.mimetype === 'image/png') {
    return count >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (file.mimetype === 'image/jpeg') return count >= 3 && header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  return false;
}

const DOCUMENT_EXTENSIONS = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg'
};
const documentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
    filename: (_req, file, callback) =>
      callback(null, crypto.randomBytes(12).toString('hex') + DOCUMENT_EXTENSIONS[file.mimetype])
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => DOCUMENT_EXTENSIONS[file.mimetype]
    ? callback(null, true)
    : callback(new Error('Dokumen harus berformat PDF, PNG, atau JPG.'))
});

function removeDocument(documentPath) {
  if (typeof documentPath !== 'string' || !documentPath.startsWith('/uploads/idi/')) return;
  const filename = path.basename(documentPath);
  fs.unlink(path.join(UPLOAD_DIR, filename), (error) => {
    if (error && error.code !== 'ENOENT') console.error(`[Dokumen E-IDI] ${error.message}`);
  });
}

function uploadDocument(req, res, next) {
  documentUpload.single('dokumen')(req, res, (error) => {
    if (error) {
      if (req.file) removeDocument('/uploads/idi/' + req.file.filename);
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'Ukuran dokumen maksimal 5 MB.'
        : error.message;
      return res.status(400).json({ error: message });
    }
    if (req.file) {
      try {
        if (!verifySignature(req.file)) {
          removeDocument('/uploads/idi/' + req.file.filename);
          return res.status(400).json({ error: 'Isi file tidak sesuai dengan format dokumen yang dipilih.' });
        }
      } catch (verificationError) {
        removeDocument('/uploads/idi/' + req.file.filename);
        return next(verificationError);
      }
    }
    next();
  });
}

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY_HOPS) {
  const hops = Number(process.env.TRUST_PROXY_HOPS);
  if (!Number.isInteger(hops) || hops < 1 || hops > 5) {
    throw new Error('TRUST_PROXY_HOPS harus bilangan bulat antara 1 dan 5.');
  }
  app.set('trust proxy', hops);
}
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  next();
});
app.use(express.json({ limit: '10kb' }));

app.post('/api/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Login admin belum dikonfigurasi.' });
  const now = Date.now();
  const ip = req.ip;
  const window = loginWindows.get(ip);
  if (!window || window.resetAt <= now) {
    loginWindows.set(ip, { count: 0, resetAt: now + 15 * 60 * 1000 });
    loginAttempts.delete(ip);
  }
  if ((loginAttempts.get(ip) || 0) >= 5) {
    return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.' });
  }
  const password = String((req.body && req.body.password) || '');
  if (!safeEqual(password, ADMIN_PASSWORD)) {
    loginAttempts.set(ip, (loginAttempts.get(ip) || 0) + 1);
    return res.status(401).json({ error: 'Password salah.' });
  }
  loginAttempts.delete(ip);
  loginWindows.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, now + SESSION_MS);
  setSessionCookie(res, token, SESSION_MS / 1000);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = getCookie(req, 'idi_sid');
  if (token) sessions.delete(token);
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (_req, res) => res.json({ ok: true }));
app.get('/api/idi', (_req, res) => res.json(appState.dataset));
app.get('/api/session', (req, res) => res.json({ admin: isAdmin(req) }));

app.post('/api/idi/indikator', requireAdmin, uploadDocument, asyncRoute(async (req, res) => {
  const value = validateIndicator(req.body || {});
  if (value.errors.length) {
    if (req.file) removeDocument('/uploads/idi/' + req.file.filename);
    return res.status(400).json({ error: value.errors.join(' ') });
  }
  const documentPath = req.file ? '/uploads/idi/' + req.file.filename : '';
  const documentName = req.file ? cleanName(req.file.originalname) : '';
  const id = crypto.randomBytes(6).toString('hex');
  try {
    const indicator = await mutateDataset(
      req,
      'TAMBAH',
      `${value.indicator} (skor ${value.score})`,
      (dataset) => {
        const item = {
          id,
          aspek: value.aspect,
          indikator: value.indicator,
          catatan: value.notes,
          skor: value.score,
          dokumen: documentPath,
          dokumenNama: documentName,
          updatedAt: new Date().toISOString()
        };
        dataset.indikator.push(item);
        return item;
      }
    );
    res.status(201).json(indicator);
  } catch (error) {
    if (req.file) removeDocument(documentPath);
    throw error;
  }
}));

app.put('/api/idi/indikator/:id', requireAdmin, uploadDocument, asyncRoute(async (req, res) => {
  const value = validateIndicator(req.body || {});
  if (value.errors.length) {
    if (req.file) removeDocument('/uploads/idi/' + req.file.filename);
    return res.status(400).json({ error: value.errors.join(' ') });
  }
  const newPath = req.file ? '/uploads/idi/' + req.file.filename : '';
  try {
    const result = await mutateDataset(
      req,
      'UBAH',
      `${value.indicator} (skor diperbarui menjadi ${value.score})`,
      (dataset) => {
        const index = dataset.indikator.findIndex((item) => item.id === req.params.id);
        if (index < 0) {
          const error = new Error('Indikator tidak ditemukan.');
          error.status = 404;
          throw error;
        }
        const current = dataset.indikator[index];
        const removeOld = req.body.hapus_dokumen === 'on' && !req.file;
        const documentPath = req.file ? newPath : removeOld ? '' : current.dokumen || '';
        const documentName = req.file
          ? cleanName(req.file.originalname)
          : removeOld ? '' : current.dokumenNama || '';
        const item = {
          ...current,
          aspek: value.aspect,
          indikator: value.indicator,
          catatan: value.notes,
          skor: value.score,
          dokumen: documentPath,
          dokumenNama: documentName,
          updatedAt: new Date().toISOString()
        };
        dataset.indikator[index] = item;
        return { item, oldPath: current.dokumen || '' };
      }
    );
    if (result.oldPath && result.oldPath !== result.item.dokumen) removeDocument(result.oldPath);
    res.json(result.item);
  } catch (error) {
    if (req.file) removeDocument(newPath);
    throw error;
  }
}));

app.delete('/api/idi/indikator/:id', requireAdmin, asyncRoute(async (req, res) => {
  const removed = await mutateDataset(req, 'HAPUS', `Indikator ${req.params.id}`, (dataset) => {
    const index = dataset.indikator.findIndex((item) => item.id === req.params.id);
    if (index < 0) {
      const error = new Error('Indikator tidak ditemukan.');
      error.status = 404;
      throw error;
    }
    return dataset.indikator.splice(index, 1)[0];
  });
  if (removed.dokumen) removeDocument(removed.dokumen);
  res.json({ ok: true });
}));

app.get(['/admin', '/admin/', '/admin/index.html'], (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin/login.html?next=%2Fadmin%2F');
  res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html'));
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html')));
app.use((error, req, res, next) => {
  console.error(`[HTTP ${req.method} ${req.path}] ${error.message}`);
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) ? error.status : 500;
  res.status(status).json({
    error: status === 503 ? error.message : 'Terjadi kesalahan internal. Coba lagi nanti.'
  });
});

app.listen(PORT, () => process.stdout.write(`E-IDI server listening on port ${PORT}\n`));
