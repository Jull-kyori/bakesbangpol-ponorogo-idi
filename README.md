# Indeks Demokrasi Indonesia Kabupaten Ponorogo

Aplikasi mandiri untuk publikasi dan pengelolaan data Indeks Demokrasi Indonesia (IDI) Kabupaten Ponorogo. Aplikasi ini tidak berbagi kode server, sesi admin, maupun database dengan situs Bakesbangpol.

## Menjalankan lokal

Membutuhkan Node.js 18+ dan PostgreSQL 14+.

```powershell
npm install
Copy-Item .env.example .env
```

Isi `DATABASE_URL` dan `IDI_ADMIN_PASSWORD` pada `.env`. Untuk produksi, gunakan password acak minimal 16 karakter, HTTPS, dan `COOKIE_SECURE=true`.

Jalankan skema dan pratinjau impor:

```powershell
npm run db:migrate
npm run db:import -- --file data/idi.json
```

Pratinjau tidak menulis data. Terapkan hanya setelah jumlah record dan sumbernya diverifikasi:

```powershell
npm run db:import -- --file data/idi.json --apply
npm start
```

Situs tersedia di `http://localhost:3100/`; panel pengelola di `http://localhost:3100/admin/`.

### Riwayat audit lama

`data/idi-audit.log` tidak dilacak Git karena berisi alamat IP. Jika file audit lokal tersedia dan sudah ditinjau untuk impor, jalankan importer dengan `--audit-file data/idi-audit.log`. Audit perubahan baru disimpan di PostgreSQL.

Importer mempertahankan ID indikator, menolak sumber JSON yang berubah untuk dataset yang sudah diimpor, dan membatalkan seluruh transaksi jika terjadi kesalahan. File JSON sumber tidak diubah atau dihapus.

## Struktur data PostgreSQL

Migrasi berversi berada di `migrations/`. Tabel utama:

- `idi_datasets`: metadata tahun kajian, periode data, skor total, dan dataset aktif.
- `idi_aspects`, `idi_trends`, `idi_indicators`: skor aspek, tren, indikator, catatan, serta referensi dokumen.
- `idi_audit`: catatan perubahan admin.
- `idi_schema_migrations`: versi skema yang telah diterapkan.

Dokumen tetap disimpan sebagai file pada `public/uploads/idi/`; PostgreSQL menyimpan path dan nama berkasnya. Gunakan disk persisten dan backup untuk database serta dokumen. Aplikasi memakai sesi dan pembatasan login dalam memori, jadi satu instance diperlukan sampai layanan sesi/rate-limit bersama disiapkan.

## Perintah

- `npm start` — jalankan server.
- `npm run db:migrate` — terapkan migrasi skema yang belum dijalankan.
- `npm run db:import -- --file <path>` — validasi dan pratinjau JSON.
- `npm run db:import -- --file <path> --apply` — impor dalam transaksi.

Jangan commit `.env`, backup database, file audit, atau dokumen unggahan.
