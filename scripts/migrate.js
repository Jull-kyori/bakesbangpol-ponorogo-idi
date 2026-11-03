'use strict';
require('./load-env');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL wajib diatur sebelum menjalankan migrasi.');

async function main() {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS idi_schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const directory = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(directory).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
    for (const file of files) {
      const version = file.slice(0, file.indexOf('_'));
      const existing = await client.query(
        'SELECT 1 FROM idi_schema_migrations WHERE version = $1',
        [version]
      );
      if (existing.rowCount) continue;

      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(directory, file), 'utf8'));
        await client.query('INSERT INTO idi_schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        process.stdout.write(`Applied ${file}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[DB migrate] ${error.message}`);
  process.exitCode = 1;
});
