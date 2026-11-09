/* Penyimpanan bersama: akun tim, sesi login, dan data project.
   Mode lokal: semua tersimpan di localStorage browser ini (belum ada server). */
(function (global) {
  'use strict';

  const KEYS = {
    users: 'alur:users:v1',
    session: 'alur:session:v1',
    data: 'alur:data:v2',
    loginFails: 'alur:login-fails:v1',
  };

  const SESSION_MAX_MS = 12 * 60 * 60 * 1000; // 12 jam sesi maksimal (remember=true)
  const SESSION_MAX_MS_SHORT = 60 * 60 * 1000; // 1 jam bila tidak ingat
  const LOGIN_MAX_FAILS = 5;
  const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 menit

  // Akun contoh agar daftar PIC project tidak kosong. Password semua: demo123
  const SEED_PASSWORD = 'demo123';
  const SEED_USERS = [
    ['rina', 'Rina Kartika', 'admin'],
    ['dimas', 'Dimas Prakoso', 'manager'],
    ['sari', 'Sari Wulandari', 'finance'],
    ['bagus', 'Bagus Hartono', 'user'],
    ['nadia', 'Nadia Putri', 'user'],
    ['yoga', 'Yoga Saputra', 'user'],
  ];

  // Role menentukan apa yang boleh dilakukan. Daftar lengkap ada di app.js (CAN).
  const ROLES = [
    { id: 'user', label: 'User', desc: 'Jalankan project yang dia pegang: input lead sampai jadi Deal.' },
    { id: 'finance', label: 'Finance', desc: 'Lengkapi dokumen dan nominal project yang sudah Deal.' },
    { id: 'manager', label: 'Manager', desc: 'Kelola seluruh project dan client, termasuk Tidak Deal dan hapus.' },
    { id: 'admin', label: 'Admin', desc: 'Semua akses manager, ditambah kelola akun karyawan dan role.' },
  ];
  const ROLE_IDS = ROLES.map((r) => r.id);
  const isRole = (r) => ROLE_IDS.includes(r);

  function readJSON(storage, key, fallback) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJSON(storage, key, value) {
    storage.setItem(key, JSON.stringify(value));
  }

  const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

  function randomHex(bytes) {
    const a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return toHex(a);
  }

  async function hashPassword(password, salt) {
    const data = new TextEncoder().encode(`${salt}:${password}`);
    if (global.crypto && crypto.subtle) {
      return toHex(await crypto.subtle.digest('SHA-256', data));
    }
    // Cadangan bila crypto.subtle tidak tersedia (non-kriptografis).
    let h = 0x811c9dc5;
    data.forEach((b) => { h = Math.imul(h ^ b, 0x01000193) >>> 0; });
    return `fnv-${h.toString(16)}`;
  }

  // ----- Akun -----
  function getUsers() {
    const users = readJSON(localStorage, KEYS.users, []);
    return Array.isArray(users) ? users : [];
  }

  const normUsername = (u) => String(u || '').trim().toLowerCase();
  const usernameOf = (u) => normUsername(u.username || String(u.email || '').split('@')[0]);
  const isActive = (u) => !u.deletedAt;
  const activeUsers = () => getUsers().filter(isActive);

  function publicUsers() {
    migrateUsernames();
    return getUsers().map((u) => ({
      id: u.id, name: u.name, username: usernameOf(u), role: isRole(u.role) ? u.role : 'user',
      createdAt: u.createdAt, deletedAt: u.deletedAt || null, active: isActive(u),
    }));
  }

  // Role wajib ada dan minimal satu admin aktif, supaya kelola akun tidak terkunci.
  function ensureRoles() {
    const users = getUsers();
    if (!users.length) return;
    let changed = false;
    users.forEach((u) => {
      if (!isRole(u.role)) {
        u.role = 'user';
        changed = true;
      }
    });
    const activeAdmins = users.filter((u) => isActive(u) && u.role === 'admin');
    if (!activeAdmins.length) {
      const first = [...activeUsers()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0]
        || [...users].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
      if (first) { first.role = 'admin'; delete first.deletedAt; changed = true; }
    }
    if (changed) writeJSON(localStorage, KEYS.users, users);
  }

  async function ensureSeed() {
    if (getUsers().length) {
      migrateUsernames();
      ensureRoles();
      return;
    }
    const users = [];
    for (const [key, name, role] of SEED_USERS) {
      const salt = randomHex(16);
      users.push({
        id: `u-${key}`,
        name,
        username: key,
        role,
        salt,
        hash: await hashPassword(SEED_PASSWORD, salt),
        createdAt: new Date().toISOString(),
      });
    }
    writeJSON(localStorage, KEYS.users, users);
  }

  // Migrasi akun lama: email rina@tim.local jadi username rina, field email dibuang.
  function migrateUsernames() {
    const users = getUsers();
    if (!users.length) return;
    let changed = false;
    users.forEach((u) => {
      if (!u.username) { u.username = usernameOf(u); changed = true; }
      u.username = normUsername(u.username);
      if ('email' in u) { delete u.email; changed = true; }
    });
    if (changed) writeJSON(localStorage, KEYS.users, users);
  }

  // ----- Rate limit login -----
  function readFails() {
    const f = readJSON(localStorage, KEYS.loginFails, null);
    if (!f || !Array.isArray(f.attempts)) return { attempts: [] };
    const now = Date.now();
    f.attempts = f.attempts.filter((t) => now - t < LOGIN_WINDOW_MS);
    return f;
  }
  function isLoginLocked() {
    return readFails().attempts.length >= LOGIN_MAX_FAILS;
  }
  function recordLoginFail() {
    const f = readFails();
    f.attempts.push(Date.now());
    writeJSON(localStorage, KEYS.loginFails, f);
  }
  function clearLoginFails() {
    localStorage.removeItem(KEYS.loginFails);
  }
  function loginRetryAfterSec() {
    const f = readFails();
    if (f.attempts.length < LOGIN_MAX_FAILS) return 0;
    const oldest = f.attempts[0] || Date.now();
    return Math.max(0, Math.ceil((LOGIN_WINDOW_MS - (Date.now() - oldest)) / 1000));
  }

  async function login(username, password) {
    migrateUsernames();
    ensureRoles();
    if (isLoginLocked()) {
      throw new Error(`Terlalu banyak percobaan. Coba lagi ${loginRetryAfterSec()} detik lagi.`);
    }
    const u = normUsername(String(username || '').split('@')[0]);
    const found = getUsers().find((x) => usernameOf(x) === u);
    if (!found || found.deletedAt) { recordLoginFail(); return null; }
    const hash = await hashPassword(password, found.salt);
    if (hash !== found.hash) { recordLoginFail(); return null; }
    clearLoginFails();
    return {
      id: found.id, name: found.name, username: usernameOf(found), role: isRole(found.role) ? found.role : 'user',
    };
  }

  async function verifyPassword(userId, password) {
    const found = getUsers().find((x) => x.id === userId);
    if (!found || found.deletedAt) return false;
    const hash = await hashPassword(password || '', found.salt);
    return hash === found.hash;
  }

  async function register({ name, username, password, role }) {
    migrateUsernames();
    const users = getUsers();
    const u = normUsername(username);
    if (users.some((x) => usernameOf(x) === u)) {
      throw new Error('Username ini sudah terdaftar. Silakan masuk.');
    }
    const salt = randomHex(16);
    const created = {
      id: `u-${randomHex(6)}`,
      name: String(name).trim(),
      username: u,
      // Akun pertama di browser ini jadi admin agar kelola akun tidak terkunci.
      role: isRole(role) ? role : (users.length ? 'user' : 'admin'),
      salt,
      hash: await hashPassword(password, salt),
      createdAt: new Date().toISOString(),
    };
    users.push(created);
    writeJSON(localStorage, KEYS.users, users);
    return { id: created.id, name: created.name, username: created.username, role: created.role };
  }

  // ----- Kelola karyawan -----
  // Dipakai dari halaman Karyawan. Mengubah nama di sini otomatis mengubah nama
  // PIC di seluruh project karena project hanya menyimpan id karyawan.
  async function updateUser(id, { name, username, password, role }) {
    migrateUsernames();
    const users = getUsers();
    const found = users.find((x) => x.id === id);
    if (!found) throw new Error('Karyawan tidak ditemukan.');
    const u = normUsername(username);
    if (users.some((x) => x.id !== id && usernameOf(x) === u)) {
      throw new Error('Username ini sudah dipakai karyawan lain.');
    }
    // Admin terakhir tidak boleh diturunkan, nanti tidak ada yang bisa kelola akun.
    if (isRole(role) && role !== 'admin' && found.role === 'admin'
      && activeUsers().filter((x) => x.role === 'admin').length === 1 && isActive(found)) {
      throw new Error('Ini admin terakhir. Angkat admin lain lebih dulu sebelum mengubah role ini.');
    }
    found.name = String(name).trim();
    found.username = u;
    delete found.email;
    if (isRole(role)) found.role = role;
    if (password) {
      found.salt = randomHex(16);
      found.hash = await hashPassword(password, found.salt);
    }
    writeJSON(localStorage, KEYS.users, users);
    return { id: found.id, name: found.name, username: found.username, role: found.role };
  }

  // Nonaktifkan akun: tidak bisa login lagi, tapi data project tetap ada.
  // Project yang memakai id ini tetap tampil dengan nama terakhir via publicUsers.
  function deactivateUser(id) {
    const users = getUsers();
    const found = users.find((x) => x.id === id);
    if (!found) throw new Error('Karyawan tidak ditemukan.');
    if (found.deletedAt) return found;
    if (found.role === 'admin' && activeUsers().filter((x) => x.role === 'admin').length === 1) {
      throw new Error('Ini admin terakhir. Angkat admin lain lebih dulu sebelum menonaktifkan.');
    }
    found.deletedAt = new Date().toISOString();
    writeJSON(localStorage, KEYS.users, users);
    return found;
  }

  function restoreUser(id) {
    const users = getUsers();
    const found = users.find((x) => x.id === id);
    if (!found) throw new Error('Karyawan tidak ditemukan.');
    delete found.deletedAt;
    writeJSON(localStorage, KEYS.users, users);
    return found;
  }

  // Reset password oleh Admin (lupa password). Tanpa server tidak ada reset mandiri via email.
  async function resetPassword(id, newPassword) {
    if (!newPassword || newPassword.length < 6) throw new Error('Password baru minimal 6 karakter.');
    const users = getUsers();
    const found = users.find((x) => x.id === id);
    if (!found) throw new Error('Karyawan tidak ditemukan.');
    found.salt = randomHex(16);
    found.hash = await hashPassword(newPassword, found.salt);
    writeJSON(localStorage, KEYS.users, users);
    return true;
  }

  function userCount() {
    return getUsers().length;
  }

  // ----- Sesi -----
  function setSession(userId, remember) {
    clearSession();
    writeJSON(remember ? localStorage : sessionStorage, KEYS.session, { userId, at: Date.now(), remember: Boolean(remember) });
  }

  function clearSession() {
    localStorage.removeItem(KEYS.session);
    sessionStorage.removeItem(KEYS.session);
  }

  function currentUser() {
    const s = readJSON(sessionStorage, KEYS.session, null) || readJSON(localStorage, KEYS.session, null);
    if (!s || !s.userId) return null;
    const max = s.remember ? SESSION_MAX_MS : SESSION_MAX_MS_SHORT;
    if (!s.at || Date.now() - s.at > max) {
      clearSession();
      return null;
    }
    ensureRoles();
    const u = publicUsers().find((x) => x.id === s.userId);
    if (!u || u.deletedAt) { clearSession(); return null; }
    return u;
  }

  // ---------------------------------------------------------------------------
  // Berkas: disimpan di IndexedDB, bukan localStorage.
  // Kuota localStorage (±5 MB) tidak cukup untuk invoice dan bukti bayar tiap
  // termin. Yang masuk localStorage hanya metadata berkas (id, nama, ukuran).
  // ---------------------------------------------------------------------------
  const FILE_DB = 'alur-files';
  const FILE_STORE = 'files';
  let dbPromise = null;

  function openFileDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        reject(new Error('Browser ini tidak mendukung IndexedDB.'));
        return;
      }
      const req = indexedDB.open(FILE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(FILE_STORE)) {
          db.createObjectStore(FILE_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB gagal dibuka.'));
    });
    return dbPromise;
  }

  async function fileTx(mode, run) {
    const db = await openFileDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FILE_STORE, mode);
      const req = run(tx.objectStore(FILE_STORE));
      tx.onabort = () => reject(tx.error || new Error('Transaksi berkas dibatalkan.'));
      tx.onerror = () => reject(tx.error || new Error('Transaksi berkas gagal.'));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
    });
  }

  // Menyimpan File apa adanya. Yang dikembalikan hanya metadata untuk disimpan
  // bersama data project.
  async function putFile(file) {
    const id = `f-${randomHex(10)}`;
    await fileTx('readwrite', (store) => store.put({
      id, name: file.name, size: file.size, type: file.type, at: new Date().toISOString(), blob: file,
    }));
    return { id, name: file.name, size: file.size, type: file.type };
  }

  const getFile = (id) => fileTx('readonly', (store) => store.get(id));

  async function deleteFiles(ids) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return;
    try {
      await fileTx('readwrite', (store) => {
        list.forEach((id) => store.delete(id));
        return null;
      });
    } catch {
      // Berkas gagal dihapus bukan alasan untuk membatalkan pekerjaan pengguna.
    }
  }

  // Memicu unduhan tanpa menyimpan object URL di DOM.
  async function downloadFile(meta) {
    if (!meta) return false;
    let url = meta.dataUrl || '';   // berkas lama masih tersimpan sebagai data URL
    let revoke = false;
    if (!url && meta.id) {
      const rec = await getFile(meta.id);
      if (!rec || !rec.blob) return false;
      url = URL.createObjectURL(rec.blob);
      revoke = true;
    }
    if (!url) return false;
    const a = document.createElement('a');
    a.href = url;
    a.download = meta.name || 'berkas';
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  }

  function isPreviewable(meta) {
    const t = String((meta && meta.type) || '').toLowerCase();
    const n = String((meta && meta.name) || '').toLowerCase();
    if (t === 'application/pdf' || n.endsWith('.pdf')) return true;
    if (t.startsWith('image/')) return true;
    if (/\.(png|jpe?g|webp|gif|svg)$/.test(n)) return true;
    return false;
  }

  // Preview PDF/gambar di tab baru. Return true bila dibuka, false bila tidak bisa.
  async function previewFile(meta) {
    if (!meta) return false;
    let url = meta.dataUrl || '';
    let revoke = false;
    let type = meta.type || '';
    if (!url && meta.id) {
      const rec = await getFile(meta.id);
      if (!rec || !rec.blob) return false;
      type = rec.blob.type || type;
      url = URL.createObjectURL(rec.blob);
      revoke = true;
    }
    if (!url) return false;
    const canPreview = type.startsWith('image/') || type === 'application/pdf'
      || /\.(pdf|png|jpe?g|webp|gif|svg)$/i.test(meta.name || '');
    if (!canPreview) { if (revoke) URL.revokeObjectURL(url); return false; }
    const w = window.open(url, '_blank', 'noopener,noreferrer');
    if (revoke) setTimeout(() => URL.revokeObjectURL(url), 60000);
    return Boolean(w);
  }

  // ----- Data project -----
  function loadData() {
    const data = readJSON(localStorage, KEYS.data, null);
    if (!data || !Array.isArray(data.projects)) {
      return { seq: 0, qlSeq: {}, clients: [], projects: [], audit: [], masterHistory: [] };
    }
    const out = {
      seq: Number.isInteger(data.seq) ? data.seq : data.projects.length,
      // Nomor QL berurutan per tipe project, mis. { 'Mutiari Garden': 4 }.
      qlSeq: (data.qlSeq && typeof data.qlSeq === 'object') ? data.qlSeq : {},
      clients: Array.isArray(data.clients) ? data.clients : [],
      projects: data.projects,
      master: (data.master && typeof data.master === 'object') ? data.master : null,
      audit: Array.isArray(data.audit) ? data.audit : [],
      masterHistory: Array.isArray(data.masterHistory) ? data.masterHistory : [],
    };
    migrateClients(out);
    return out;
  }

  // Project versi lama menyimpan data client di dalam project itu sendiri.
  // Di sini data tersebut dipindahkan ke daftar client, supaya satu client
  // bisa dipakai banyak project dan cukup diperbarui di satu tempat.
  function migrateClients(data) {
    let changed = false;
    data.projects.forEach((p) => {
      if (p.clientId && data.clients.some((c) => c.id === p.clientId)) return;
      const name = String(p.company || '').trim();
      if (!name) return;
      const key = name.toLowerCase();
      let c = data.clients.find((x) => String(x.name).trim().toLowerCase() === key);
      if (!c) {
        c = {
          id: `c-${randomHex(6)}`,
          name,
          pic: p.clientPic || '',
          wa: p.wa || '',
          email: p.email || '',
          notes: '',
          createdAt: p.createdAt || new Date().toISOString(),
        };
        data.clients.push(c);
      }
      p.clientId = c.id;
      delete p.company;
      delete p.clientPic;
      delete p.wa;
      delete p.email;
      changed = true;
    });
    if (changed) {
      try {
        saveData(data);
      } catch {
        // Gagal menyimpan hasil migrasi bukan alasan untuk menghentikan aplikasi.
      }
    }
  }

  function saveData(data) {
    writeJSON(localStorage, KEYS.data, data);
  }

  global.AlurStore = {
    KEYS,
    SEED_PASSWORD,
    ROLES,
    SESSION_MAX_MS,
    SESSION_MAX_MS_SHORT,
    LOGIN_MAX_FAILS,
    ensureSeed,
    ensureRoles,
    login,
    isLoginLocked,
    loginRetryAfterSec,
    verifyPassword,
    register,
    updateUser,
    deactivateUser,
    restoreUser,
    resetPassword,
    userCount,
    publicUsers,
    activeUsers,
    setSession,
    clearSession,
    currentUser,
    loadData,
    saveData,
    putFile,
    getFile,
    deleteFiles,
    downloadFile,
    previewFile,
    isPreviewable,
  };
})(window);
