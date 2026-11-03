# Indeks Demokrasi Indonesia Kabupaten Ponorogo

Aplikasi mandiri untuk publikasi dan pengelolaan data Indeks Demokrasi Indonesia (IDI) Kabupaten Ponorogo. Aplikasi ini tidak berbagi kode server maupun sesi admin dengan situs Bakesbangpol dan tidak menggunakan database.

## Menjalankan lokal

Membutuhkan Node.js 18+.

```powershell
npm install
Copy-Item .env.example .env
```

Isi `IDI_ADMIN_PASSWORD` pada `.env`. Untuk produksi, gunakan password acak minimal 16 karakter, HTTPS, dan `COOKIE_SECURE=true`.

Jalankan aplikasi:

```powershell
npm start
```

Situs tersedia di `http://localhost:3100/`; panel pengelola di `http://localhost:3100/admin/`.

## Penyimpanan data

`data/idi.json` adalah data awal yang dilacak Git dan tidak diubah oleh aplikasi. Perubahan admin disimpan ke `data/idi-state.json`; riwayat audit yang dapat memuat alamat IP disimpan di file privat yang sama dan tidak dilacak Git. Dokumen diunggah ke `public/uploads/idi/`.

Cadangkan `data/idi-state.json` dan `public/uploads/idi/`. Keduanya memerlukan disk persisten yang dapat ditulis. Aplikasi memakai sesi dan pembatasan login dalam memori, jadi jalankan satu instance.

## Perintah

- `npm start` — jalankan server.

Jangan commit `.env`, `data/idi-state.json`, file audit, atau dokumen unggahan.
