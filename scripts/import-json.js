'use strict';
require('./load-env');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : process.argv[index + 1] || '';
}

const inputPath = path.resolve(option('--file') || path.join(__dirname, '..', 'data', 'idi.json'));
const auditPath = option('--audit-file') ? path.resolve(option('--audit-file')) : '';
const apply = process.argv.includes('--apply');
const raw = fs.readFileSync(inputPath);
const data = JSON.parse(raw.toString('utf8'));

if (
  !data || !Number.isInteger(data.tahun) || !Number.isInteger(data.periodeData) ||
  !Array.isArray(data.aspek) || !Array.isArray(data.tren) || !Array.isArray(data.indikator)
) {
  throw new Error('JSON E-IDI tidak memiliki tahun, periode, aspek, tren, dan indikator yang valid.');
}
if (data.aspek.length === 0 || data.indikator.length === 0) {
  throw new Error('JSON E-IDI harus memiliki aspek dan indikator.');
}
if (data.skorTotal != null && (!Number.isFinite(Number(data.skorTotal)) || data.skorTotal < 0 || data.skorTotal > 100)) {
  throw new Error('Skor total E-IDI harus berada antara 0 dan 100.');
}
const aspectCodes = new Set(data.aspek.map((aspect) => aspect.kode));
if (data.indikator.some((item) => !item.id || !aspectCodes.has(item.aspek))) {
  throw new Error('Setiap indikator harus memiliki ID dan mengacu ke aspek yang tersedia.');
}
for (const item of data.aspek) {
  if (!Number.isFinite(Number(item.skor)) || Number(item.skor) < 0 || Number(item.skor) > 100) {
    throw new Error(`Skor aspek tidak valid: ${item.kode}`);
  }
}
for (const item of data.indikator) {
  if (!Number.isFinite(Number(item.skor)) || Number(item.skor) < 0 || Number(item.skor) > 100) {
    throw new Error(`Skor indikator tidak valid: ${item.id}`);
  }
}
for (const item of data.tren) {
  if (!Number.isInteger(item.tahun) || !Number.isFinite(Number(item.nilai)) || item.nilai < 0 || item.nilai > 100) {
    throw new Error(`Titik tren tidak valid: ${JSON.stringify(item)}`);
  }
}
const auditLines = auditPath
  ? fs.readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const [occurredAt, actorIp, action, ...detail] = line.split('\t');
    if (!occurredAt || !['TAMBAH', 'UBAH', 'HAPUS'].includes(action) || !detail.length) {
      throw new Error('Format log audit E-IDI tidak valid.');
    }
    if (Number.isNaN(Date.parse(occurredAt))) throw new Error('Waktu pada log audit E-IDI tidak valid.');
    return { occurredAt, actorIp: actorIp || '', action, detail: detail.join(' ') };
  })
  : [];
const digest = crypto.createHash('sha256').update(raw).digest('hex');
const datasetKey = `ponorogo-${data.tahun}-${data.periodeData}`;

process.stdout.write(
  `Dataset ${datasetKey}: ${data.aspek.length} aspek, ${data.tren.length} tren, ` +
  `${data.indikator.length} indikator, ${auditLines.length} entri audit.\n`
);
if (!apply) {
  process.stdout.write('Dry-run saja. Tambahkan --apply untuk menulis ke PostgreSQL.\n');
  process.exit(0);
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL wajib diatur untuk import.');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id, source_sha256 FROM idi_datasets WHERE dataset_key = $1 FOR UPDATE',
      [datasetKey]
    );
    if (existing.rowCount) {
      if (existing.rows[0].source_sha256.trim() !== digest) {
        throw new Error(`Dataset ${datasetKey} sudah ada dengan isi berbeda; import dibatalkan.`);
      }
      await client.query('COMMIT');
      process.stdout.write(`Dataset ${datasetKey} sudah diimpor dari sumber yang sama; tidak ada perubahan.\n`);
      return;
    }

    await client.query('UPDATE idi_datasets SET is_current = FALSE WHERE is_current = TRUE');
    const dataset = await client.query(
      `INSERT INTO idi_datasets
         (dataset_key, region, assessment_year, data_year, total_score, trend_source, source_sha256, is_current)
       VALUES ($1, 'Kabupaten Ponorogo', $2, $3, $4, $5, $6, TRUE)
       RETURNING id`,
      [datasetKey, data.tahun, data.periodeData, data.skorTotal, data.sumberTren || '', digest]
    );
    const datasetId = dataset.rows[0].id;

    for (const [index, aspect] of data.aspek.entries()) {
      await client.query(
        `INSERT INTO idi_aspects
          (dataset_id, code, display_order, roman, title, short_title, description, score, icon)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [datasetId, aspect.kode, index + 1, aspect.romawi || '', aspect.judul,
          aspect.singkat || '', aspect.deskripsi || '', aspect.skor, aspect.ikon || '']
      );
    }
    for (const trend of data.tren) {
      await client.query(
        'INSERT INTO idi_trends (dataset_id, year, value) VALUES ($1, $2, $3)',
        [datasetId, trend.tahun, trend.nilai]
      );
    }
    for (const [index, item] of data.indikator.entries()) {
      await client.query(
        `INSERT INTO idi_indicators
          (id, dataset_id, aspect_code, display_order, indicator, notes, score, document_path, document_name, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, NOW()))`,
        [item.id, datasetId, item.aspek, index + 1, item.indikator, item.catatan || '',
          item.skor, item.dokumen || '', item.dokumenNama || '', item.updatedAt || null]
      );
    }
    for (const item of auditLines) {
      await client.query(
        'INSERT INTO idi_audit (occurred_at, actor_ip, action, detail) VALUES ($1, $2, $3, $4)',
        [item.occurredAt, item.actorIp, item.action, item.detail]
      );
    }
    await client.query('COMMIT');
    process.stdout.write(`Imported ${datasetKey} to PostgreSQL.\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[JSON import] ${error.message}`);
  process.exitCode = 1;
});
