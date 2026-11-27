/* Penyimpanan bersama: akun tim, sesi login, dan data project.
   Mode lokal: semua tersimpan di localStorage browser ini (belum ada server). */
(function (global) {
  'use strict';

  const KEYS = {
    users: 'alur:users:v1',
    session: 'alur:session:v1',
    data: 'alur:data:v2',
    loginFails: 'alur:login-fails:v1',
    seedAdmin: 'alur:seed-admin:v1',
  };

  const LOGIN_MAX_FAILS = 5;
  const LOGIN_WINDOW_MS = 5 * 60 * 1000; // 5 menit

  // Akun contoh. Admin memakai password khusus, lainnya demo123.
  const SEED_PASSWORD = 'demo123';
  const SEED_ADMIN_USERNAME = 'goden';
  const SEED_ADMIN_PASSWORD = 'lebahganteng';
  const SEED_USERS = [
    [SEED_ADMIN_USERNAME, 'Goden', 'admin', SEED_ADMIN_PASSWORD],
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

  // ----- Mode API -----
  const API_BASE = String(global.PMS_API_URL || '').replace(/\/$/, '');
  const API_MODE = Boolean(API_BASE);
  const API_TOKEN_KEY = 'alur:api-token:v1';
  const API_USER_KEY = 'alur:api-user:v1';
  let snapshotCache = null;
  let syncTimer = 0;
  let syncChain = Promise.resolve();

  function apiToken() {
    return localStorage.getItem(API_TOKEN_KEY) || sessionStorage.getItem(API_TOKEN_KEY) || '';
  }

  function setApiToken(token, remember) {
    localStorage.removeItem(API_TOKEN_KEY);
    sessionStorage.removeItem(API_TOKEN_KEY);
    if (!token) return;
    (remember ? localStorage : sessionStorage).setItem(API_TOKEN_KEY, token);
  }

  async function api(path, { method = 'GET', body = null, auth = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== null) headers['Content-Type'] = 'application/json';
    const token = apiToken();
    if (auth && !token) {
      clearSession();
      if (global.location && !/login\.html$/.test(global.location.pathname)) {
        global.location.replace('login.html');
      }
      throw new Error('Sesi berakhir. Silakan login ulang.');
    }
    if (auth && token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method, headers, body: body === null ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('API tidak dapat dijangkau. Cek koneksi dan URL backend.');
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      if (res.status === 401 && auth) {
        clearSession();
        try {
          if (global.location && !/login\.html$/.test(global.location.pathname)) {
            global.location.replace('login.html');
          }
        } catch { /* abaikan bila bukan browser */ }
      }
      const err = new Error((data && data.message) || `API gagal (${res.status}).`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function init() {
    if (!API_MODE) return;
    const token = apiToken();
    if (!token) { clearSession(); return; }
    try {
      const snapshot = await api('/api/snapshot');
      snapshotCache = snapshot;
      if (Array.isArray(snapshot.users)) writeJSON(localStorage, KEYS.users, snapshot.users);
      writeJSON(localStorage, KEYS.data, snapshot);
      // Antre sinkron sekali saat buka: migrasi dokumen lama ke S3 bila perlu.
      saveData(snapshot);
    } catch (err) {
      if (err.status === 401) clearSession();
      throw err;
    }
  }

  async function allocateNumber(kind, payload) {
    if (!API_MODE) return null;
    return api(`/api/numbers/${kind}`, {
      method: 'POST',
      body: { ...payload, idempotencyKey: payload.idempotencyKey || `${kind}-${payload.projectId || Date.now()}` },
    });
  }

  async function changeOwnPassword(password) {
    if (!API_MODE) {
      const me = currentUser();
      return updateUser(me.id, { name: me.name, username: me.username, password, role: me.role });
    }
    const data = await api('/api/auth/change-password', { method: 'POST', body: { password } });
    const storage = sessionStorage.getItem(API_USER_KEY) ? sessionStorage : localStorage;
    const me = readJSON(storage, API_USER_KEY, null);
    if (me) { me.mustChangePassword = false; writeJSON(storage, API_USER_KEY, me); }
    return data;
  }

  async function refreshUsers() {
    if (!API_MODE || !apiToken()) return;
    try {
      const snapshot = await api('/api/snapshot');
      snapshotCache = snapshot;
      if (Array.isArray(snapshot.users)) writeJSON(localStorage, KEYS.users, snapshot.users);
      writeJSON(localStorage, KEYS.data, snapshot);
    } catch { /* pakai cache lokal */ }
  }

  async function apiLogin(username, password, remember = true) {
    if (isLoginLocked()) throw new Error(`Terlalu banyak percobaan. Coba lagi ${loginRetryAfterSec()} detik lagi.`);
    try {
      const data = await api('/api/auth/login', {
        method: 'POST', body: { username: normUsername(username), password }, auth: false,
      });
      clearLoginFails();
      setApiToken(data.token, remember);
      writeJSON(remember ? localStorage : sessionStorage, API_USER_KEY, data.user);
      await refreshUsers();
      return data.user;
    } catch (err) {
      if (err.status === 401) { recordLoginFail(); return null; }
      throw err;
    }
  }

  async function apiRegister(payload) {
    const created = await api('/api/users', {
      method: 'POST',
      body: { name: payload.name, username: normUsername(payload.username), password: payload.password, role: payload.role },
    });
    await refreshUsers();
    return created;
  }

  async function apiUpdateUser(id, payload) {
    const body = {};
    if (payload.name !== undefined) body.name = payload.name;
    if (payload.username !== undefined) body.username = normUsername(payload.username);
    if (payload.role !== undefined) body.role = payload.role;
    if (payload.password !== undefined) body.password = payload.password;
    if (payload.deactivate !== undefined) body.deactivate = payload.deactivate;
    const result = await api(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body });
    await refreshUsers();
    const me = readJSON(localStorage, API_USER_KEY, null);
    if (me && me.id === id && payload.password) me.mustChangePassword = false;
    return result;
  }

  async function apiVerifyPassword(userId, password) {
    if (!apiToken()) return false;
    const result = await api('/api/auth/verify', { method: 'POST', body: { password } });
    return Boolean(result.ok);
  }

  async function apiResetPassword(id, password) {
    const result = await api(`/api/users/${encodeURIComponent(id)}/reset-password`, {
      method: 'POST', body: { password },
    });
    await refreshUsers();
    return result.ok;
  }

  async function apiDeleteUser(id) {
    if (!API_MODE) return { ok: true };
    const result = await api(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await refreshUsers();
    return result;
  }

  async function apiDeleteProjects(ids) {
    if (!API_MODE) return { ok: true };
    return api('/api/projects/delete', { method: 'POST', body: { ids } });
  }

  async function apiResetData() {
    if (!API_MODE) return { ok: true };
    const result = await api('/api/reset', { method: 'POST' });
    await refreshUsers();
    return result;
  }

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
      mustChangePassword: Boolean(u.mustChangePassword),
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

  async function migrateSeedAdmin() {
    if (readJSON(localStorage, KEYS.seedAdmin, null)) return;
    const users = getUsers();
    if (!users.length) return;
    let changed = false;
    let admin = users.find((u) => usernameOf(u) === SEED_ADMIN_USERNAME);
    const legacy = users.find((u) => usernameOf(u) === 'rina');
    if (!admin && legacy) {
      legacy.username = SEED_ADMIN_USERNAME;
      legacy.name = 'Goden';
      admin = legacy;
      changed = true;
    }
    if (admin) {
      admin.role = 'admin';
      delete admin.deletedAt;
      delete admin.mustChangePassword;
      const salt = randomHex(16);
      admin.salt = salt;
      admin.hash = await hashPassword(SEED_ADMIN_PASSWORD, salt);
      changed = true;
    }
    if (changed) writeJSON(localStorage, KEYS.users, users);
    writeJSON(localStorage, KEYS.seedAdmin, { done: true });
  }

  async function ensureSeed() {
    if (getUsers().length) {
      migrateUsernames();
      ensureRoles();
      await migrateSeedAdmin();
      return;
    }
    const users = [];
    for (const [key, name, role, password = SEED_PASSWORD] of SEED_USERS) {
      const salt = randomHex(16);
      users.push({
        id: `u-${key}`,
        name,
        username: key,
        role,
        salt,
        hash: await hashPassword(password, salt),
        createdAt: new Date().toISOString(),
      });
    }
    writeJSON(localStorage, KEYS.users, users);
    writeJSON(localStorage, KEYS.seedAdmin, { done: true });
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
      mustChangePassword: Boolean(found.mustChangePassword),
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
      mustChangePassword: true,
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
      found.mustChangePassword = false;
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
    found.mustChangePassword = true;
    writeJSON(localStorage, KEYS.users, users);
    return true;
  }

  // Reset karyawan: hapus semua akun non-admin, admin tetap.
  function deleteNonAdminUsers() {
    const users = getUsers();
    const before = users.length;
    const kept = users.filter((u) => u.role === 'admin');
    if (kept.length === before) return 0;
    writeJSON(localStorage, KEYS.users, kept);
    return before - kept.length;
  }

  function userCount() {
    return getUsers().length;
  }

  // ----- Sesi -----
  function setSession(userId, remember) {
    // Jangan hapus token API yang baru dibuat apiLogin().
    // clearSession() hanya dipakai saat logout atau sesi tidak valid.
    if (!API_MODE) clearSession();
    else {
      localStorage.removeItem(KEYS.session);
      sessionStorage.removeItem(KEYS.session);
    }
    writeJSON(remember ? localStorage : sessionStorage, KEYS.session, { userId, at: Date.now(), remember: Boolean(remember) });
  }

  function clearSession() {
    localStorage.removeItem(KEYS.session);
    sessionStorage.removeItem(KEYS.session);
    localStorage.removeItem(API_TOKEN_KEY);
    sessionStorage.removeItem(API_TOKEN_KEY);
    localStorage.removeItem(API_USER_KEY);
    sessionStorage.removeItem(API_USER_KEY);
  }

  function currentUser() {
    if (API_MODE && !apiToken()) { clearSession(); return null; }
    const s = readJSON(sessionStorage, KEYS.session, null) || readJSON(localStorage, KEYS.session, null);
    if (!s || !s.userId) return null;
    // Sesi tidak kedaluwarsa otomatis. Keluar hanya lewat tombol Keluar,
    // atau saat akun dinonaktifkan/dihapus Admin.
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

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        const comma = text.indexOf(',');
        resolve(comma >= 0 ? text.slice(comma + 1) : text);
      };
      reader.onerror = () => reject(reader.error || new Error('Gagal membaca berkas.'));
      reader.readAsDataURL(file);
    });
  }

  async function apiFileUrl(meta) {
    const res = await api(`/api/files/${encodeURIComponent(meta.id)}/url`);
    return res.url;
  }

  function putDirect(url, file, type, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      if (type) xhr.setRequestHeader('Content-Type', type);
      if (typeof xhr.upload.onprogress === 'undefined') { /* progress tidak didukung */ }
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable || typeof onProgress !== 'function') return;
        onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300)
        ? resolve() : reject(new Error(`Unggah S3 gagal (${xhr.status}).`));
      xhr.onerror = () => reject(new Error('Koneksi ke penyimpanan gagal.'));
      xhr.send(file);
    });
  }

  // Menyimpan File apa adanya. Yang dikembalikan hanya metadata untuk disimpan
  // bersama data project.
  async function putFile(file, context = {}, onProgress = null) {
    if (API_MODE && apiToken()) {
      const payload = {
        projectId: context.projectId || '',
        slot: context.slot || '',
        name: file.name,
        size: file.size,
        type: file.type || '',
        username: context.username || (currentUser() || {}).username || '',
      };
      try {
        const signed = await api('/api/files/presign', { method: 'POST', body: payload });
        if (signed && signed.url) {
          await putDirect(signed.url, file, file.type || '', onProgress);
          return api('/api/files/confirm', {
            method: 'POST',
            body: { ...payload, id: signed.id, key: signed.key, rev: signed.rev },
          });
        }
      } catch (err) {
        // S3 direkt gagal (misal CORS). Fallback lewat backend memakai base64.
      }
      return api('/api/files', {
        method: 'POST',
        body: { ...payload, data: await fileToBase64(file) },
      });
    }
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
    if (API_MODE && apiToken()) {
      try { await api('/api/files/delete', { method: 'POST', body: { ids: list } }); }
      catch { /* penghapusan gagal tidak membatalkan pekerjaan */ }
      return;
    }
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
    if (API_MODE && apiToken() && meta.id && !meta.dataUrl) {
      try {
        const url = await apiFileUrl(meta);
        const a = document.createElement('a');
        a.href = url; a.download = meta.name || 'berkas';
        document.body.appendChild(a); a.click(); a.remove();
        return true;
      } catch (err) {
        throw new Error(err.message || 'Gagal mengunduh berkas dari server.');
      }
    }
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
    if (API_MODE && apiToken() && meta.id && !meta.dataUrl) {
      if (!isPreviewable(meta)) return false;
      try {
        const url = await apiFileUrl(meta);
        return Boolean(window.open(url, '_blank', 'noopener,noreferrer'));
      } catch (err) {
        throw new Error(err.message || 'Gagal membuka berkas dari server.');
      }
    }
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

  // ----- Backup & restore (JSON, satu file berisi data + berkas) -----
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error('Gagal membaca berkas.'));
      reader.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(dataUrl, fallbackType) {
    const text = String(dataUrl || '');
    const comma = text.indexOf(',');
    if (comma < 0) throw new Error('Berkas backup rusak.');
    const head = text.slice(0, comma);
    const match = /^data:([^;]+);base64$/i.exec(head);
    if (!match) throw new Error('Format berkas backup tidak dikenali.');
    const bin = atob(text.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: match[1] || fallbackType || 'application/octet-stream' });
  }

  async function backupAll() {
    const files = [];
    try {
      const recs = await fileTx('readonly', (store) => store.getAll()) || [];
      for (const rec of recs) {
        if (!rec || !rec.blob) continue;
        files.push({
          id: rec.id, name: rec.name || '', size: rec.size || rec.blob.size,
          type: rec.type || rec.blob.type || '', at: rec.at || '',
          dataUrl: await blobToDataUrl(rec.blob),
        });
      }
    } catch {
      // Berkas gagal dibaca bukan alasan membatalkan backup data utama.
    }
    return {
      app: 'prasasti-pms', version: 2, at: new Date().toISOString(),
      users: getUsers(), data: readJSON(localStorage, KEYS.data, null), files,
    };
  }

  async function restoreAll(payload) {
    if (!payload || payload.app !== 'prasasti-pms') throw new Error('File ini bukan backup Prasasti PMS.');
    if (!Array.isArray(payload.users) || !payload.users.length) throw new Error('Backup tidak berisi akun.');
    if (!payload.data || !Array.isArray(payload.data.projects)) throw new Error('Backup tidak berisi data project.');
    if (!Array.isArray(payload.files)) throw new Error('Struktur berkas backup tidak valid.');
    writeJSON(localStorage, KEYS.users, payload.users);
    saveData(payload.data);
    let restoredFiles = 0;
    for (const f of payload.files) {
      if (!f || !f.id || !f.dataUrl) continue;
      try {
        const blob = dataUrlToBlob(f.dataUrl, f.type);
        await fileTx('readwrite', (store) => store.put({
          id: f.id, name: f.name || '', size: f.size || blob.size,
          type: f.type || blob.type || '', at: f.at || new Date().toISOString(), blob,
        }));
        restoredFiles += 1;
      } catch {
        // Satu berkas rusak tidak membatalkan pemulihan project dan akun.
      }
    }
    clearSession();
    return { projects: payload.data.projects.length, users: payload.users.length, files: restoredFiles };
  }

  // ----- Data project -----
  function loadData() {
    if (API_MODE && snapshotCache) return snapshotCache;
    const data = readJSON(localStorage, KEYS.data, null);
    if (!data || !Array.isArray(data.projects)) {
      return { seq: 0, qlSeq: {}, poSeq: 0, clients: [], projects: [], audit: [], masterHistory: [] };
    }
    const out = {
      seq: Number.isInteger(data.seq) ? data.seq : data.projects.length,
      // Nomor QL berurutan per tipe project, mis. { 'Mutiari Garden': 4 }.
      qlSeq: (data.qlSeq && typeof data.qlSeq === 'object') ? data.qlSeq : {},
      // Nomor PO berurutan global, mis. PO-0004.
      poSeq: Number.isInteger(data.poSeq) ? data.poSeq : 0,
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

  async function prepareSyncPayload(data) {
    const projects = data.projects || [];
    const username = (currentUser() || {}).username || 'api';
    for (const p of projects) {
      const docs = p.docs || {};
      for (const [slot, current] of Object.entries(docs)) {
        if (!current || !current.id) continue;
        const revs = Array.isArray(current.history) ? current.history.slice() : [];
        if (!revs.length || revs[revs.length - 1].id !== current.id) {
          revs.push({ ...current, rev: current.rev || revs.length + 1 });
        }
        for (let i = 0; i < revs.length; i += 1) {
          const rev = revs[i];
          if (!rev || rev.key || rev.file_key) continue;
          let blob = null;
          if (rev.dataUrl) {
            try { blob = dataUrlToBlob(rev.dataUrl, rev.type); } catch { /* abaikan */ }
          }
          if (!blob && rev.id) {
            try {
              const rec = await getFile(rev.id);
              if (rec && rec.blob) blob = rec.blob;
              else if (rec && rec.dataUrl) blob = dataUrlToBlob(rec.dataUrl, rec.type);
            } catch { /* abaikan */ }
          }
          if (!blob) continue;
          try {
            const uploaded = await putFile(blob, {
              projectId: p.id, slot, projectName: p.name, username,
            });
            revs[i] = { ...rev, ...uploaded };
          } catch { /* gagal upload dokumen lama, biarkan error muncul saat dibuka */ }
        }
        if (revs.length > 1) current.history = revs.slice(0, -1);
        Object.assign(current, revs[revs.length - 1]);
      }
    }
    return {
      projects,
      clients: data.clients || [],
      audit: data.audit || [],
      master: data.master || null,
      users: getUsers(),
    };
  }

  function saveData(data) {
    writeJSON(localStorage, KEYS.data, data);
    if (!API_MODE) return;
    snapshotCache = data;
    if (!apiToken()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncChain = syncChain
        .then(async () => {
          const ready = await prepareSyncPayload(data);
          writeJSON(localStorage, KEYS.data, data);
          return api('/api/sync', { method: 'POST', body: ready });
        })
        .catch((err) => {
          console.error('Sinkronisasi ke API gagal:', err);
          if (typeof global.dispatchEvent === 'function') {
            global.dispatchEvent(new CustomEvent('alur:sync-error', { detail: { message: err.message } }));
          }
        });
    }, 400);
  }

  global.AlurStore = {
    KEYS,
    SEED_PASSWORD,
    ROLES,
    LOGIN_MAX_FAILS,
    API_MODE,
    init,
    ensureSeed,
    ensureRoles,
    login: API_MODE ? apiLogin : login,
    isLoginLocked,
    loginRetryAfterSec,
    verifyPassword: API_MODE ? apiVerifyPassword : verifyPassword,
    register: API_MODE ? apiRegister : register,
    updateUser: API_MODE ? apiUpdateUser : updateUser,
    changeOwnPassword,
    allocateNumber,
    deactivateUser,
    restoreUser,
    resetPassword: API_MODE ? apiResetPassword : resetPassword,
    deleteUser: API_MODE ? apiDeleteUser : null,
    deleteProjectsPermanently: apiDeleteProjects,
    resetServerData: apiResetData,
    deleteNonAdminUsers,
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
    backupAll,
    restoreAll,
  };
})(window);
