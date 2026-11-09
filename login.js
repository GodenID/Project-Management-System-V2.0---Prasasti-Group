/* Halaman masuk. Akun dibuat Admin dari menu Karyawan. */
(async () => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const form = $('#auth-form');
  const alertEl = $('#form-alert');
  const submitBtn = $('#auth-submit');

  const FIELDS = ['a-username', 'a-password'];

  await AlurStore.ensureSeed();

  // Rate-limit UI: blokir submit bila terlalu banyak gagal.
  function refreshLock() {
    const locked = AlurStore.isLoginLocked();
    submitBtn.disabled = locked;
    if (locked) formAlert(`Terlalu banyak percobaan. Coba lagi ${AlurStore.loginRetryAfterSec()} detik lagi.`);
    return locked;
  }
  refreshLock();
  setInterval(refreshLock, 1000);

  // Sudah login: langsung ke aplikasi. Sesi kedaluwarsa dibersihkan di store.
  if (AlurStore.currentUser()) {
    location.replace('index.html');
    return;
  }

  function clearErrors() {
    alertEl.textContent = '';
    alertEl.classList.remove('is-shown');
    FIELDS.forEach((id) => {
      const el = $(`#${id}`);
      el.removeAttribute('aria-invalid');
      el.removeAttribute('aria-describedby');
      $(`#${id}-err`).textContent = '';
    });
  }

  function setError(id, msg) {
    const el = $(`#${id}`);
    el.setAttribute('aria-invalid', 'true');
    el.setAttribute('aria-describedby', `${id}-err`);
    $(`#${id}-err`).textContent = msg;
  }

  function formAlert(msg) {
    alertEl.textContent = msg;
    alertEl.classList.add('is-shown');
  }

  const pwToggle = $('#toggle-pw');
  pwToggle.addEventListener('click', () => {
    const show = $('#a-password').type === 'password';
    $('#a-password').type = show ? 'text' : 'password';
    pwToggle.textContent = show ? 'Sembunyikan' : 'Tampilkan';
    pwToggle.setAttribute('aria-pressed', String(show));
  });

  FIELDS.forEach((id) => $(`#${id}`).addEventListener('input', () => {
    $(`#${id}`).removeAttribute('aria-invalid');
    $(`#${id}-err`).textContent = '';
  }));

  function enter(user) {
    AlurStore.setSession(user.id, $('#a-remember').checked);
    submitBtn.textContent = 'Membuka pipeline…';
    location.replace('index.html');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();

    const username = $('#a-username').value.trim().toLowerCase();
    const password = $('#a-password').value;

    const errs = [];
    if (!username) errs.push(['a-username', 'Username wajib diisi.']);
    else if (!/^[a-z0-9._-]{3,40}$/.test(username)) errs.push(['a-username', 'Username 3-40 karakter: huruf kecil, angka, titik, garis bawah, atau strip.']);
    if (!password) errs.push(['a-password', 'Password wajib diisi.']);

    if (errs.length) {
      errs.forEach(([id, msg]) => setError(id, msg));
      $(`#${errs[0][0]}`).focus();
      return;
    }
    if (refreshLock()) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Memeriksa…';
    try {
      const found = await AlurStore.login(username, password);
      if (!found) {
        formAlert('Username atau password salah, atau akun nonaktif.');
        $('#a-password').select();
        refreshLock();
        return;
      }
      enter(found);
    } catch (err) {
      formAlert(err.message || 'Terjadi kesalahan. Coba lagi.');
      refreshLock();
    } finally {
      if (document.body.contains(submitBtn)) {
        submitBtn.disabled = false;
        if (!submitBtn.textContent.includes('pipeline')) {
          submitBtn.textContent = 'Masuk';
        }
      }
    }
  });

})();
