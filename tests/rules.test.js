const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadStoreSource() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'store.js'), 'utf8');
  return src;
}

// Uji sintaks dan aturan NEXT/DOCS lewat parsing statis ringan
// (app.js IIFE butuh DOM, jadi aturan diuji via salinan logika di sini).
test('store.js tidak punya syntax error', () => {
  new vm.Script(loadStoreSource());
});

test('app.js tidak punya syntax error', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  new vm.Script(src);
});

test('login.js tidak punya syntax error', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'login.js'), 'utf8');
  new vm.Script(src);
});

test('aturan NEXT satu arah', () => {
  const NEXT = { lead: ['ql', 'lost'], ql: ['deal', 'lost'], deal: [], lost: [] };
  assert.deepEqual(NEXT.lead.includes('deal'), false);
  assert.deepEqual(NEXT.deal, []);
  assert.deepEqual(NEXT.lost, []);
});

test('password acak dan wajib ganti saat login pertama', () => {
  const store = loadStoreSource();
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const login = fs.readFileSync(path.join(__dirname, '..', 'login.js'), 'utf8');
  const loginHtml = fs.readFileSync(path.join(__dirname, '..', 'login.html'), 'utf8');
  assert.match(store, /mustChangePassword: true/);
  assert.match(store, /found\.mustChangePassword = false/);
  assert.match(store, /found\.mustChangePassword = true/);
  assert.match(app, /function randomPassword/);
  assert.match(app, /passwordRaw \|\| randomPassword\(\)/);
  assert.match(loginHtml, /id="force-pw-form"/);
  assert.match(loginHtml, /placeholder="mis\. goden"/);
  assert.match(login, /found\.mustChangePassword/);
  assert.match(login, /showForcePassword\(found, password\)/);
  assert.match(login, /await AlurStore\.changeOwnPassword\(next\)/);
});

test('seed admin goden password lebahganteng, rina dimigrasi sekali', () => {
  const store = loadStoreSource();
  assert.match(store, /SEED_ADMIN_USERNAME = 'goden'/);
  assert.match(store, /SEED_ADMIN_PASSWORD = 'lebahganteng'/);
  assert.match(store, /\[SEED_ADMIN_USERNAME, 'Goden', 'admin', SEED_ADMIN_PASSWORD\]/);
  assert.match(store, /async function migrateSeedAdmin/);
  assert.match(store, /usernameOf\(u\) === 'rina'/);
  assert.match(store, /KEYS\.seedAdmin/);
  assert.match(store, /for \(const \[key, name, role, password = SEED_PASSWORD\] of SEED_USERS\)/);
});

test('login: rate limit aktif, sesi tanpa auto logout', () => {
  const src = loadStoreSource();
  assert.match(src, /LOGIN_MAX_FAILS/);
  assert.match(src, /LOGIN_WINDOW_MS = 5 \* 60 \* 1000/);
  assert.match(src, /function currentUser/);
  assert.doesNotMatch(src, /SESSION_MAX_MS/);
  assert.doesNotMatch(src, /Date\.now\(\) - s\.at/);
  assert.match(src, /deactivateUser/);
  assert.match(src, /deletedAt/);
});

test('audit + delete permanen + ketik yakin', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(src, /function audit\(/);
  assert.match(src, /requireText/);
  assert.match(src, /masterHistory/);
});

test('data contoh punya tombol permanen di sidebar Admin', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /data-action="sample-data" id="btn-sample-data"/);
  assert.match(html, /id="side-data-actions"/);
  assert.match(html, /id="side-data-label"/);
  assert.match(app, /#btn-sample-data/);
  assert.match(app, /async function loadSampleFromMenu/);
  assert.match(app, /requireText: 'yakin'/);
});

test('data contoh punya demo umum 3 dan 7 hari di Lead serta QL', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(app, /Demo Lead 3 Hari - Kuning/);
  assert.match(app, /Demo Lead 7 Hari - Merah/);
  assert.match(app, /Demo QL 3 Hari - Kuning/);
  assert.match(app, /Demo QL 7 Hari - Merah/);
  assert.match(app, /\[\['lead', 7\]\]/);
  assert.match(app, /\[\['lead', 12\], \['ql', 3\]\]/);
  assert.match(app, /\[\['lead', 16\], \['ql', 7\]\]/);
});

test('WA 10–13 digit dan tanggal selesai tidak sebelum mulai', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.equal((app.match(/harus 10–13 digit/g) || []).length, 2);
  assert.match(app, /waRaw\.length < 10 \|\| waRaw\.length > 13/);
  assert.match(app, /data\.end < data\.start/);
  assert.match(app, /Tanggal akhir tidak boleh sebelum tanggal mulai/);
  assert.match(html, /id="f-end" type="date"/);
});

test('tujuh halaman legal saling terhubung', () => {
  const files = ['privacy.html', 'policy.html', 'disclaimer.html', 'security.html', 'access.html', 'account.html', 'contact.html'];
  const links = ['privacy.html', 'policy.html', 'disclaimer.html', 'security.html', 'access.html', 'account.html', 'contact.html'];
  for (const file of files) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const link of links) {
      assert.ok(html.includes(`href="${link}"`), `${file} tidak punya tautan ${link}`);
    }
  }
  const shell = ['index.html', 'login.html'];
  for (const file of shell) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const link of links) {
      assert.ok(html.includes(`href="${link}"`), `${file} tidak punya tautan ${link}`);
    }
  }
});

test('5000+ data: indeks lookup dan pencarian debounce', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(app, /function rebuildIndexes/);
  assert.match(app, /projectIndex = new Map/);
  assert.match(app, /clientIndex = new Map/);
  assert.match(app, /clientProjects = new Map/);
  assert.match(app, /const find = \(id\) => projectIndex\.get/);
  assert.match(app, /const clientById = \(id\) => clientIndex\.get/);
  assert.match(app, /setTimeout\(renderView, 120\)/);
  assert.match(app, /setTimeout\(\(\) => \{[\s\S]*renderView\(\)[\s\S]*\}, 120\)/);
});

test('frontend memakai API mode dan config URL backend', () => {
  const store = loadStoreSource();
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const login = fs.readFileSync(path.join(__dirname, '..', 'login.html'), 'utf8');
  const config = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
  assert.match(store, /global\.PMS_API_URL/);
  assert.match(store, /async function init/);
  assert.match(store, /api\/snapshot/);
  assert.match(store, /api\/sync/);
  assert.match(config, /window\.PMS_API_URL =/);
  assert.match(index, /src="config\.js"/);
  assert.match(login, /src="config\.js"/);
});

test('umur di tahap: 3 hari kuning, 7 hari merah', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(app, /d >= 7 \? 'late' : d >= 3 \? 'warn'/);
  assert.match(app, /<th class="c-stage-age">Di tahap<\/th>/);
  assert.match(app, /stageAgeCell\(p\)/);
  assert.match(css, /\.stage-age--warn/);
  assert.match(css, /\.stage-age--late/);
});

test('trash: hapus lunak, pulihkan, hapus permanen admin saja', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(src, /function trashView/);
  assert.match(src, /deletedAt/);
  assert.match(src, /function restoreProject/);
  assert.match(src, /function deleteForever/);
  assert.match(src, /deleteForever: \['admin'\]/);
  assert.match(src, /slug === 'sampah'/);
});

test('nomor PO berurutan global PO-0001, melekat saat Deal', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const store = loadStoreSource();
  assert.match(store, /poSeq/);
  assert.match(app, /function takePoNo/);
  assert.match(app, /PO-\$\{String\(db\.poSeq\)\.padStart\(4, '0'\)\}/);
  assert.match(app, /AlurStore\.allocateNumber\('po'/);
  assert.match(store, /API_MODE/);
  assert.match(store, /api\/numbers\/\$\{kind\}/);
  assert.match(app, /<th class="c-po">Nomor PO<\/th>/);
  assert.match(app, /<dt>Nomor PO<\/dt>/);
  assert.match(app, /db\.poSeq = 0;/);
});

test('takePoNo: berurutan dan lompat nomor yang sudah terpakai', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const src = app.match(/function takePoNo\(\) \{[\s\S]*?\n  \}/);
  assert.ok(src, 'takePoNo tidak ditemukan');
  const db = { projects: [{ id: 'a', poNo: 'PO-0001' }], poSeq: 1 };
  const AlurStore = { loadData: () => ({ projects: [], poSeq: 0 }) };
  const takePoNo = new Function('db', 'AlurStore', `${src[0]}\nreturn takePoNo;`)(db, AlurStore);
  assert.equal(takePoNo(), 'PO-0002');
  assert.equal(takePoNo(), 'PO-0003');
  assert.equal(db.poSeq, 3);
});

test('trash: cari, pilih massal, pulihkan, kosongkan sampah', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(app, /id="trash-search"/);
  assert.match(app, /data-trash-select/);
  assert.match(app, /data-action="restore-selected-trash"/);
  assert.match(app, /data-action="delete-selected-trash"/);
  assert.match(app, /data-action="empty-trash"/);
  assert.match(app, /function purgeProjects/);
  assert.match(app, /trashList/);
});

test('backup/restore JSON: admin saja, isi dan berkas ikut', () => {
  const store = loadStoreSource();
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(store, /async function backupAll/);
  assert.match(store, /async function restoreAll/);
  assert.match(store, /app: 'prasasti-pms'/);
  assert.match(store, /blobToDataUrl/);
  assert.match(store, /restoreAll,/);
  assert.match(app, /a === 'backup-data'/);
  assert.match(app, /a === 'restore-data'/);
  assert.match(html, /data-action="backup-data"/);
  assert.match(html, /data-action="restore-data"/);
  assert.match(html, /id="restore-file"/);
  assert.match(app, /can\('resetData'\)/);
});

test('dataUrlToBlob: berkas backup kembali ke isi semula', async () => {
  const src = loadStoreSource().match(/function dataUrlToBlob\(dataUrl, fallbackType\) \{[\s\S]*?\n  \}/);
  assert.ok(src, 'dataUrlToBlob tidak ditemukan');
  const dataUrlToBlob = new Function(`${src[0]}\nreturn dataUrlToBlob;`)();
  const text = 'dokumen contoh';
  const encoded = Buffer.from(text).toString('base64');
  const blob = dataUrlToBlob(`data:text/plain;base64,${encoded}`, 'application/octet-stream');
  assert.equal(blob.type, 'text/plain');
  assert.equal(await blob.text(), text);
});

test('reset data hapus project, client, dan karyawan non-admin', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const store = loadStoreSource();
  assert.match(src, /resetData: \['admin'\]/);
  assert.match(src, /requirePassword/);
  assert.match(src, /resetAllProjects/);
  assert.match(src, /db\.clients = \[\]/);
  assert.match(src, /deleteNonAdminUsers/);
  assert.match(store, /function deleteNonAdminUsers/);
  assert.match(store, /u\.role === 'admin'/);
});
