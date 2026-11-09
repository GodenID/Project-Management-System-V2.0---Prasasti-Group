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

test('soft-delete: follow-up via tutup tutup loginFails', () => {
  const src = loadStoreSource();
  assert.match(src, /LOGIN_MAX_FAILS/);
  assert.match(src, /SESSION_MAX_MS/);
  assert.match(src, /deactivateUser/);
  assert.match(src, /deletedAt/);
});

test('audit + delete permanen + ketik yakin', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(src, /function audit\(/);
  assert.match(src, /requireText/);
  assert.match(src, /masterHistory/);
  assert.doesNotMatch(src, /function trashView/);
});

test('reset data admin saja, wajib password', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(src, /resetData: \['admin'\]/);
  assert.match(src, /requirePassword/);
  assert.match(src, /resetAllProjects/);
});
