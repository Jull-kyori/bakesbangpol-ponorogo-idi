'use strict';
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = Number(process.env.PORT || 3100);
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.IDI_ADMIN_PASSWORD || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_MS = 8 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads', 'idi');
const ASPECTS = new Set(['Kebebasan Sipil', 'Kesetaraan Politik', 'Lembaga Demokrasi']);
const sessions = new Map();
const loginAttempts = new Map();
const loginWindows = new Map();

if (!DATABASE_URL) throw new Error('DATABASE_URL wajib diatur sebelum menjalankan aplikasi E-IDI.');
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

const pool = new Pool({ connectionString: DATABASE_URL });
pool.on('error', (error) => console.error(`[PostgreSQL] ${error.message}`));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

async function getCurrentDataset(client) {
  const result = await client.query(
    'SELECT * FROM idi_datasets WHERE is_current = TRUE LIMIT 1'
  );
  if (!result.rowCount) {
    const error = new Error('Data E-IDI belum diimpor ke PostgreSQL.');
    error.status = 503;
    throw error;
  }
  return result.rows[0];
}

async function readPublishedData() {
  const client = await pool.connect();
  try {
    const dataset = await getCurrentDataset(client);
    const [aspects, trends, indicators] = await Promise.all([
      client.query(
        `SELECT code AS kode, roman AS romawi, title AS judul, short_title AS singkat,
                description AS deskripsi, score AS skor, icon AS ikon
         FROM idi_aspects WHERE dataset_id = $1 ORDER BY display_order`,
        [dataset.id]
      ),
      client.query(
        'SELECT year AS tahun, value AS nilai FROM idi_trends WHERE dataset_id = $1 ORDER BY year',
        [dataset.id]
      ),
      client.query(
        `SELECT id, aspect_code AS aspek, indicator AS indikator, notes AS catatan,
                score AS skor, document_path AS dokumen, document_name AS "dokumenNama",
                updated_at AS "updatedAt"
         FROM idi_indicators WHERE dataset_id = $1 ORDER BY display_order`,
        [dataset.id]
      )
    ]);
    return {
      tahun: dataset.assessment_year,
      periodeData: dataset.data_year,
      skorTotal: dataset.total_score === null ? null : Number(dataset.total_score),
      sumberTren: dataset.trend_source,
      aspek: aspects.rows.map((row) => ({ ...row, skor: Number(row.skor) })),
      tren: trends.rows.map((row) => ({ ...row, nilai: Number(row.nilai) })),
      indikator: indicators.rows.map((row) => ({ ...row, skor: Number(row.skor) }))
    };
  } finally {
    client.release();
  }
}

async function writeAudit(client, req, action, detail) {
  await client.query(
    'INSERT INTO idi_audit (actor_ip, action, detail) VALUES ($1, $2, $3)',
    [req.ip, action, String(detail).replace(/[\t\r\n]+/g, ' ')]
  );
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
app.get('/api/idi', asyncRoute(async (_req, res) => res.json(await readPublishedData())));
app.get('/api/session', (req, res) => res.json({ admin: isAdmin(req) }));

app.post('/api/idi/indikator', requireAdmin, uploadDocument, asyncRoute(async (req, res) => {
  const value = validateIndicator(req.body || {});
  if (value.errors.length) {
    if (req.file) removeDocument('/uploads/idi/' + req.file.filename);
    return res.status(400).json({ error: value.errors.join(' ') });
  }
  const client = await pool.connect();
  const documentPath = req.file ? '/uploads/idi/' + req.file.filename : '';
  const documentName = req.file ? cleanName(req.file.originalname) : '';
  const id = crypto.randomBytes(6).toString('hex');
  try {
    await client.query('BEGIN');
    const dataset = await getCurrentDataset(client);
    await client.query('SELECT id FROM idi_datasets WHERE id = $1 FOR UPDATE', [dataset.id]);
    const result = await client.query(
      `INSERT INTO idi_indicators
        (id, dataset_id, aspect_code, display_order, indicator, notes, score, document_path, document_name)
       SELECT $1, $2, $3, COALESCE(MAX(display_order), 0) + 1, $4, $5, $6, $7, $8
       FROM idi_indicators WHERE dataset_id = $2
       RETURNING id, aspect_code AS aspek, indicator AS indikator, notes AS catatan,
                 score AS skor, document_path AS dokumen, document_name AS "dokumenNama",
                 updated_at AS "updatedAt"`,
      [id, dataset.id, value.aspect, value.indicator, value.notes, value.score, documentPath, documentName]
    );
    await writeAudit(client, req, 'TAMBAH', `${value.indicator} (skor ${value.score})`);
    await client.query('COMMIT');
    res.status(201).json({ ...result.rows[0], skor: Number(result.rows[0].skor) });
  } catch (error) {
    await client.query('ROLLBACK');
    if (req.file) removeDocument(documentPath);
    throw error;
  } finally {
    client.release();
  }
}));

app.put('/api/idi/indikator/:id', requireAdmin, uploadDocument, asyncRoute(async (req, res) => {
  const value = validateIndicator(req.body || {});
  if (value.errors.length) {
    if (req.file) removeDocument('/uploads/idi/' + req.file.filename);
    return res.status(400).json({ error: value.errors.join(' ') });
  }
  const client = await pool.connect();
  const newPath = req.file ? '/uploads/idi/' + req.file.filename : '';
  let oldPath = '';
  try {
    await client.query('BEGIN');
    const dataset = await getCurrentDataset(client);
    const existing = await client.query(
      'SELECT score, document_path, document_name FROM idi_indicators WHERE dataset_id = $1 AND id = $2 FOR UPDATE',
      [dataset.id, req.params.id]
    );
    if (!existing.rowCount) {
      await client.query('ROLLBACK');
      if (req.file) removeDocument(newPath);
      return res.status(404).json({ error: 'Indikator tidak ditemukan.' });
    }
    const current = existing.rows[0];
    oldPath = current.document_path;
    const removeOld = req.body.hapus_dokumen === 'on' && !req.file;
    const documentPath = req.file ? newPath : removeOld ? '' : current.document_path;
    const documentName = req.file ? cleanName(req.file.originalname) : removeOld ? '' : current.document_name;
    const result = await client.query(
      `UPDATE idi_indicators
       SET aspect_code = $1, indicator = $2, notes = $3, score = $4,
           document_path = $5, document_name = $6, updated_at = NOW()
       WHERE dataset_id = $7 AND id = $8
       RETURNING id, aspect_code AS aspek, indicator AS indikator, notes AS catatan,
                 score AS skor, document_path AS dokumen, document_name AS "dokumenNama",
                 updated_at AS "updatedAt"`,
      [value.aspect, value.indicator, value.notes, value.score, documentPath, documentName, dataset.id, req.params.id]
    );
    await writeAudit(client, req, 'UBAH', `${value.indicator} (skor ${current.score || ''} -> ${value.score})`);
    await client.query('COMMIT');
    if (oldPath && oldPath !== documentPath) removeDocument(oldPath);
    res.json({ ...result.rows[0], skor: Number(result.rows[0].skor) });
  } catch (error) {
    await client.query('ROLLBACK');
    if (req.file) removeDocument(newPath);
    throw error;
  } finally {
    client.release();
  }
}));

app.delete('/api/idi/indikator/:id', requireAdmin, asyncRoute(async (req, res) => {
  const client = await pool.connect();
  let documentPath = '';
  try {
    await client.query('BEGIN');
    const dataset = await getCurrentDataset(client);
    const existing = await client.query(
      'SELECT indicator, score, document_path FROM idi_indicators WHERE dataset_id = $1 AND id = $2 FOR UPDATE',
      [dataset.id, req.params.id]
    );
    if (!existing.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Indikator tidak ditemukan.' });
    }
    const item = existing.rows[0];
    documentPath = item.document_path;
    await client.query(
      'DELETE FROM idi_indicators WHERE dataset_id = $1 AND id = $2',
      [dataset.id, req.params.id]
    );
    await writeAudit(client, req, 'HAPUS', `${item.indicator} (skor ${item.score})`);
    await client.query('COMMIT');
    removeDocument(documentPath);
    res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
