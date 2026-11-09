/* Prasasti Group — Project Management System: pipeline satu arah
   Lead Masuk -> Proses QL -> Deal, dengan cabang Tidak Deal.
   Perpindahan tahap lewat tombol, bukan geser. */
(() => {
  'use strict';

  let user = AlurStore.currentUser();
  if (!user) {
    location.replace('login.html');
    return;
  }

  // ---------------------------------------------------------------------------
  // Konfigurasi alur
  // ---------------------------------------------------------------------------
  const DAY = 86400000;

  const STAGES = {
    lead: {
      label: 'Lead Masuk', no: '01', slug: 'lead-masuk', staleDays: 7,
      desc: 'Semua project baru masuk ke sini. Untuk lanjut ke Proses QL, status QL dan nilai penawaran wajib diisi lebih dulu.',
      empty: 'Belum ada lead. Project baru yang Anda input akan muncul di sini.',
    },
    ql: {
      label: 'Proses QL', no: '02', slug: 'proses-ql', staleDays: 14,
      desc: 'Project yang sudah punya nomor QL dan nilai penawaran. Lanjutkan ke Deal bila disetujui client.',
      empty: 'Belum ada project di Proses QL. Tekan "Lanjut ke Proses QL" pada salah satu lead.',
    },
    deal: {
      label: 'Deal', no: '03', slug: 'deal', final: true,
      desc: 'Project yang sudah disepakati. Tahap final: project terkunci dan tidak bisa dipindah ke tahap lain.',
      empty: 'Belum ada project Deal.',
    },
    lost: {
      label: 'Tidak Deal', no: '—', slug: 'tidak-deal', final: true, askReason: true,
      desc: 'Project yang batal, bercabang dari Lead Masuk atau Proses QL. Alasan batal tercatat di riwayat.',
      empty: 'Belum ada project yang batal.',
    },
  };
  const ORDER = ['lead', 'ql', 'deal', 'lost'];
  const TABS = ['all', 'lead', 'ql', 'deal', 'lost'];

  // Tahap tujuan yang diizinkan. Daftar kosong = terkunci.
  const NEXT = { lead: ['ql', 'lost'], ql: ['deal', 'lost'], deal: [], lost: [] };

  // Master data default. Admin bisa mengubahnya dari halaman Master Data;
  // hasil edit tersimpan di db.master dan dipakai ulang saat aplikasi dibuka.
  const OTHER = 'Lainnya';
  const DEFAULT_TYPES = [
    {
      name: 'Prasasti Selaras',
      prefix: 'PSQL',
      // Selain Quotation yang wajib untuk semua tipe, Prasasti Selaras juga
      // mewajibkan RAB saat project jadi Deal.
      rabRequired: true,
      subtypes: ['Family Gathering', 'Employee Gathering', 'Team Building',
        'Amazing Race', 'Awarding', 'Gala Dinner', OTHER],
    },
    { name: 'Prasasti Lestari', prefix: 'PLQL', subtypes: ['CSR', OTHER] },
    {
      name: 'Mutiari Garden',
      prefix: 'MGQL',
      subtypes: ['Sewa Tanaman', 'Mini Garden', 'Hampers Anggrek', 'Taman (landscape)',
        'Vertical Garden', 'Moss Wall', 'Aquascape', 'Paludarium', OTHER],
    },
    // Mutiari Decoration belum punya daftar kategori, jadi field kategori
    // disembunyikan. Isi daftarnya dari halaman Master Data bila sudah ada.
    { name: 'Mutiari Decoration', prefix: 'MDQL', subtypes: [] },
    {
      name: 'Wood and Steel',
      prefix: 'WSQL',
      subtypes: ['Booth', 'Tempat Sampah', 'Souvenir Custom', 'Payung',
        'Tumbler', 'Kitchen Set', 'Planter Box', OTHER],
    },
  ];
  const DEFAULT_SOURCES = [
    'Iklan Website', 'SEO', 'Instagram', 'Direct Selling', 'Iklan IG',
    'Iklan Tiktok', 'Repeat Order', 'Blast Email', 'Telemarketing',
  ];
  const DEFAULT_ENTITIES = [
    { code: 'PSS', name: 'Prasasti Selaras Sinergi' },
    { code: 'PS', name: 'CV Prasasti' },
    { code: 'MAW', name: 'Mutiari Adi Warna' },
    { code: 'MGI', name: 'PT Mutiari Garden Indonesia' },
    { code: 'PWS', name: 'Prasasti Widya Sejahtera' },
  ];
  // Salinan kerja: edit/reset halaman Master Data tidak mengubah nilai
  // bawaan sebelum benar-benar disimpan.
  let PROJECT_TYPES = structuredClone(DEFAULT_TYPES);
  let ENTITIES = structuredClone(DEFAULT_ENTITIES);
  let LEAD_SOURCES = [...DEFAULT_SOURCES];
  let TYPE_BY_NAME = {};
  let ENTITY_BY_CODE = {};
  function applyMaster() {
    TYPE_BY_NAME = Object.fromEntries(PROJECT_TYPES.map((t) => [t.name, t]));
    ENTITY_BY_CODE = Object.fromEntries(ENTITIES.map((e) => [e.code, e]));
  }
  applyMaster();
  const qlPrefix = (type) => (TYPE_BY_NAME[type] ? TYPE_BY_NAME[type].prefix : 'XXQL');
  const subtypesOf = (type) => (TYPE_BY_NAME[type] ? TYPE_BY_NAME[type].subtypes : []);
  const rabRequired = (type) => Boolean(TYPE_BY_NAME[type] && TYPE_BY_NAME[type].rabRequired);
  // Dokumen project dan aturan wajibnya:
  //   always = wajib untuk semua tipe project
  //   type   = wajib hanya untuk tipe yang menandai rabRequired
  //   never  = selalu opsional
  const DOCS = [
    { id: 'quotation', label: 'Quotation', req: 'always' },
    { id: 'rab', label: 'RAB', req: 'type' },
    { id: 'proposal', label: 'Proposal', req: 'never' },
    { id: 'spk', label: 'SPK', req: 'never' },
  ];
  const docNeeded = (d, type) => d.req === 'always' || (d.req === 'type' && rabRequired(type));
  const neededDocs = (type) => DOCS.filter((d) => docNeeded(d, type));
  const MAX_DOC_BYTES = 10 * 1024 * 1024;
  const DOC_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png';

  // Hak akses per role.
  // PIC project menjalankan project sampai jadi Deal, termasuk dokumennya.
  // Finance ikut boleh melengkapi dokumen dan nominal deal.
  const CAN = {
    createProject: ['admin', 'manager', 'user'],
    editProject: ['admin', 'manager', 'user'],
    moveToQl: ['admin', 'manager', 'user'],
    editQl: ['admin', 'manager', 'user'],
    moveToDeal: ['admin', 'manager', 'user'],
    moveToLost: ['admin', 'manager'],
    editDocs: ['admin', 'manager', 'user', 'finance'],
    editClient: ['admin', 'manager', 'user'],
    deleteProject: ['admin', 'manager'],
    manageUsers: ['admin'],
    masterData: ['admin'],
  };
  // Role "user" hanya boleh menyentuh project yang dia pegang sebagai PIC.
  const OWNER_ONLY = new Set(['editProject', 'moveToQl', 'editQl', 'moveToDeal', 'editDocs']);
  const ROLE_LABEL = Object.fromEntries(AlurStore.ROLES.map((r) => [r.id, r.label]));

  const roleNames = (cap) => (CAN[cap] || []).map((r) => ROLE_LABEL[r]).join(', ');

  const QL_STATUS = [
    { id: 'belum', label: 'Belum dikerjakan', desc: 'Nomor QL sudah terbit, pengerjaan belum dimulai.' },
    { id: 'proses', label: 'Sedang dikerjakan', desc: 'Penawaran, survei, atau gambar sedang dikerjakan.' },
    { id: 'review', label: 'Sedang direview', desc: 'Penawaran sudah di tangan client, menunggu review client.' },
  ];
  const QL_BY_ID = Object.fromEntries(QL_STATUS.map((s) => [s.id, s]));
  const qlIcon = (id) => (id === 'belum' ? 'pause' : 'spin');

  const LEAD_KINDS = [
    { id: 'cold', label: 'Cold', desc: 'Bertanya saja, tidak ada kabar (tidak minta compro/catalog).' },
    { id: 'hot', label: 'Hot', desc: 'Client meminta quotation / penawaran / survey.' },
  ];
  const LEAD_BY_ID = Object.fromEntries(LEAD_KINDS.map((k) => [k.id, k]));

  // Entitas: kode untuk tampilan ringkas di tabel, nama lengkap untuk form
  // dan laporan. Entitas tidak terikat tipe project.
  const entityName = (code) => (ENTITY_BY_CODE[code] ? ENTITY_BY_CODE[code].name : '');
  const NO_ENTITY = 'Belum diisi';

  // ---------------------------------------------------------------------------
  // Utilitas
  // ---------------------------------------------------------------------------
  const ICONS = {
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7"/>',
    arrow: '<path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5"/>',
    x: '<path d="m4 4 8 8M12 4l-8 8"/>',
    edit: '<path d="M10.5 3.5l2 2L6 12H4v-2z"/>',
    trash: '<path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8.5h5l.5-8.5"/>',
    alert: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.25v.01"/>',
    check: '<path d="m3.5 8.5 3 3 6-7"/>',
    wa: '<path d="M8 2.75a5.25 5.25 0 0 0-4.5 7.95L2.75 13.25l2.6-.72A5.25 5.25 0 1 0 8 2.75Z"/><path d="M6 6.5c0 2 1.5 3.5 3.5 3.5"/>',
    mail: '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/><path d="m3 4.5 5 4 5-4"/>',
    undo: '<path d="M6 4 3 7l3 3"/><path d="M3 7h5.5A4.5 4.5 0 1 1 8.5 16"/>',
    spin: '<circle cx="8" cy="8" r="5"/><path d="M8 5.5V8l1.75 1.75"/>',
    pause: '<circle cx="8" cy="8" r="5"/><path d="M6.5 6v4M9.5 6v4"/>',
    chevron: '<path d="m6.5 3.5 4.5 4.5-4.5 4.5"/>',
    layers: '<path d="M8 2.5 13.5 5.25 8 8 2.5 5.25z"/><path d="m2.5 8.25 5.5 2.75 5.5-2.75"/><path d="m2.5 11 5.5 2.75L13.5 11"/>',
    users: '<circle cx="6" cy="5.5" r="2.25"/><path d="M2 13c.4-2.1 1.9-3.25 4-3.25S9.6 10.9 10 13"/><path d="M10.25 3.4a2.25 2.25 0 0 1 0 4.2M11.4 9.9c1.3.45 2.2 1.5 2.6 3.1"/>',
    file: '<path d="M9 2.5H4.5v11h7V5z"/><path d="M9 2.5V5h2.5"/>',
    cash: '<rect x="2" y="4" width="12" height="8" rx="1"/><circle cx="8" cy="8" r="1.75"/><path d="M4.5 8h.01M11.5 8h.01"/>',
    chart: '<path d="M2.5 13.5h11"/><rect x="3.5" y="8" width="2.5" height="4"/><rect x="7" y="5" width="2.5" height="7"/><rect x="10.5" y="2.5" width="2.5" height="9.5"/>',
    building: '<path d="M3.5 13.5V3.5h6v10"/><path d="M9.5 13.5V7h3v6.5"/><path d="M5.5 6h2M5.5 8.5h2M5.5 11h2"/>',
    upload: '<path d="M8 10.5v-8M5 5.5 8 2.5l3 3"/><path d="M3 10v3.5h10V10"/>',
    download: '<path d="M8 2.5v8M5 7.5 8 10.5l3-3"/><path d="M3 12.5h10"/>',
    shield: '<path d="M8 2.5 13 4.5v4c0 2.6-2 4.4-5 5.5-3-1.1-5-2.9-5-5.5v-4z"/>',
    sliders: '<path d="M3 5h10M3 11h10"/><circle cx="6" cy="5" r="1.6"/><circle cx="10" cy="11" r="1.6"/>',
  };
  const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${ICONS[n]}</svg>`;

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const nf = new Intl.NumberFormat('id-ID');
  const nf1 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 });
  const dFull = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  const dNoYear = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short' });
  const dTime = new Intl.DateTimeFormat('id-ID', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  function rpShort(n) {
    if (!n) return 'Rp 0';
    if (n >= 1e9) return `Rp ${nf1.format(n / 1e9)} M`;
    if (n >= 1e6) return `Rp ${nf1.format(n / 1e6)} jt`;
    if (n >= 1e3) return `Rp ${nf1.format(n / 1e3)} rb`;
    return `Rp ${nf.format(n)}`;
  }
  const rpFull = (n) => `Rp ${nf.format(n || 0)}`;

  const parseDay = (iso) => {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const todayISO = () => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  };

  function eventRange(p) {
    if (!p.start) return '—';
    const a = parseDay(p.start);
    if (!p.end || p.end === p.start) return dFull.format(a);
    const b = parseDay(p.end);
    return `${a.getFullYear() === b.getFullYear() ? dNoYear.format(a) : dFull.format(a)} – ${dFull.format(b)}`;
  }
  const eventDays = (p) => (p.start && p.end
    ? Math.max(1, Math.round((parseDay(p.end) - parseDay(p.start)) / DAY) + 1) : 1);

  function eventWhen(p) {
    if (!p.start) return null;
    const today = parseDay(todayISO());
    const start = parseDay(p.start);
    const end = parseDay(p.end || p.start);
    if (end < today) return { tone: 'past', text: 'Sudah lewat' };
    if (start <= today && today <= end) return { tone: 'now', text: 'Sedang berjalan' };
    const days = Math.round((start - today) / DAY);
    return { tone: days <= 7 ? 'soon' : 'future', text: days === 1 ? 'Besok' : `${days} hari lagi` };
  }

  const ageText = (d) => (d === 0 ? 'Hari ini' : `${d} hari`);
  const waDigits = (wa) => String(wa || '').replace(/\D/g, '');
  const waLink = (wa) => `https://wa.me/${waDigits(wa)}`;
  // Nomor lokal dikelompokkan 3-4-4, pola umum nomor seluler Indonesia.
  const groupWa = (local) => {
    const parts = [local.slice(0, 3)];
    for (let i = 3; i < local.length; i += 4) parts.push(local.slice(i, i + 4));
    return parts.filter(Boolean).join(' ');
  };
  const waLocal = (wa) => {
    const d = waDigits(wa);
    return d.startsWith('62') ? d.slice(2) : d;
  };
  const waPretty = (wa) => (waDigits(wa) ? `+62 ${groupWa(waLocal(wa))}` : '—');
  const initials = (name) => String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const digitsOnly = (v) => String(v).replace(/\D/g, '');

  const $ = (sel, root = document) => root.querySelector(sel);

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  const valid = (p) => p && typeof p.id === 'string' && typeof p.name === 'string'
    && ORDER.includes(p.stage) && Array.isArray(p.history) && typeof p.stageChangedAt === 'string';

  // Sanitasi master tersimpan. Item tak valid dibuang; daftar kosong jatuh
  // kembali ke bawaan. Awalan QL dan kode entitas dibuat unik supaya nomor
  // QL serta pilihan entitas tidak ambigu.
  function normalizeMaster(raw) {
    const cleanText = (value, max) => String(value || '').trim().slice(0, max);
    const dedupe = (items) => [...new Map(items.map((v) => [v.toLowerCase(), v])).values()];
    const types = [];
    (Array.isArray(raw.types) ? raw.types : []).forEach((t) => {
      const name = cleanText(t && t.name, 60);
      const prefix = cleanText(t && t.prefix, 8).toUpperCase();
      if (!name || !prefix || types.some((x) => x.name.toLowerCase() === name.toLowerCase()
        || x.prefix === prefix)) return;
      types.push({
        name,
        prefix,
        rabRequired: Boolean(t.rabRequired),
        subtypes: dedupe((Array.isArray(t.subtypes) ? t.subtypes : [])
          .map((s) => cleanText(s, 80)).filter(Boolean)),
      });
    });
    const entities = [];
    (Array.isArray(raw.entities) ? raw.entities : []).forEach((e) => {
      const code = cleanText(e && e.code, 8).toUpperCase();
      const name = cleanText(e && e.name, 80);
      if (!code || !name || entities.some((x) => x.code === code)) return;
      entities.push({ code, name });
    });
    const sources = dedupe((Array.isArray(raw.sources) ? raw.sources : [])
      .map((s) => cleanText(s, 80)).filter(Boolean));
    return {
      types: types.length ? types : structuredClone(DEFAULT_TYPES),
      entities: entities.length ? entities : structuredClone(DEFAULT_ENTITIES),
      sources: sources.length ? sources : [...DEFAULT_SOURCES],
    };
  }

  // Nomor QL berikutnya untuk awalan tertentu, mengikuti urutan tersimpan.
  function qlNoInUse(no) {
    return Boolean(no) && db.projects.some((p) => p.qlNo === no);
  }

  function nextQlNoForPrefix(prefix, seqValue) {
    return `${prefix}-${String((Number(seqValue) || 0) + 1).padStart(4, '0')}`;
  }

  let db = AlurStore.loadData();
  db.projects = db.projects.filter(valid);
  if (!Array.isArray(db.audit)) db.audit = [];
  if (!Array.isArray(db.masterHistory)) db.masterHistory = [];
  // Hapus = permanen langsung. Semua project di db adalah aktif.
  const alive = () => true;
  const trashed = () => false;
  const aliveProjects = () => db.projects;

  function audit(projectId, action, detail = '') {
    db.audit.push({
      id: `a-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
      projectId: projectId || '',
      at: new Date().toISOString(),
      by: user.id,
      byName: user.name,
      action, detail,
    });
    if (db.audit.length > 500) db.audit = db.audit.slice(-500);
  }
  // Master data tersimpan ikut data. Data lama belum punya: pakai default.
  // Selalu dinormalkan; data terpotong tidak boleh mengubah Master Data
  // jadi kosong atau merusak opsi form, filter, dan laporan.
  if (db.master && typeof db.master === 'object') {
    const saved = normalizeMaster(db.master);
    PROJECT_TYPES = saved.types;
    ENTITIES = saved.entities;
    LEAD_SOURCES = saved.sources;
    applyMaster();
  }

  const save = () => {
    try {
      AlurStore.saveData(db);
    } catch {
      toast('Gagal menyimpan. Penyimpanan browser penuh atau diblokir.', { tone: 'warn' });
    }
  };

  // Dipakai saat menyimpan berkas: pemanggil perlu tahu kalau kuota penuh.
  const trySave = () => {
    try {
      AlurStore.saveData(db);
      return true;
    } catch {
      return false;
    }
  };

  let team = AlurStore.publicUsers();
  const activeTeam = () => team.filter((u) => !u.deletedAt);
  const teamName = (id) => (team.find((u) => u.id === id) || {}).name || 'Karyawan nonaktif';

  const route = routeFromHash();
  const ui = {
    page: route.page, tab: ['all', 'lead', 'ql', 'deal', 'lost'].includes(route.tab) ? route.tab : 'all', query: '', detailId: null, sidebar: false,
    report: { tab: 'overview', from: '', to: '' },
    // Pagination serverless: render hanya sehalaman baris, data tetap difilter penuh.
    list: {
      page: 1, perPage: 50, sortKey: 'changed', sortDir: -1,
      filters: { stage: '', lead: '', type: '', subtype: '', entity: '', owner: '', qlStatus: '', docs: '', from: '', to: '' },
    },
    clientList: { page: 1, perPage: 50, sortKey: 'projects', sortDir: -1, status: '' },
    selected: new Set(),
  };

  // Filter tersimpan + riwayat pencarian (lokal per browser).
  const UI_KEYS = { filters: 'alur:filters:v1', qHistory: 'alur:search-history:v1' };
  function loadUiPrefs() {
    try {
      const raw = localStorage.getItem(UI_KEYS.filters);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && saved.filters) ui.list.filters = { ...ui.list.filters, ...saved.filters };
        if (saved && typeof saved.sortKey === 'string') ui.list.sortKey = saved.sortKey;
        if (saved && (saved.sortDir === 1 || saved.sortDir === -1)) ui.list.sortDir = saved.sortDir;
        if (saved && [25, 50, 100].includes(saved.perPage)) ui.list.perPage = saved.perPage;
      }
    } catch {}
  }
  function saveUiPrefs() {
    try {
      localStorage.setItem(UI_KEYS.filters, JSON.stringify({
        filters: ui.list.filters, sortKey: ui.list.sortKey, sortDir: ui.list.sortDir, perPage: ui.list.perPage,
      }));
    } catch {}
  }
  function loadSearchHistory() {
    try { const h = JSON.parse(localStorage.getItem(UI_KEYS.qHistory) || '[]'); return Array.isArray(h) ? h.filter(Boolean).slice(0, 8) : []; } catch { return []; }
  }
  function pushSearchHistory(q) {
    const v = String(q || '').trim();
    if (!v) return;
    const h = [v, ...loadSearchHistory().filter((x) => x.toLowerCase() !== v.toLowerCase())].slice(0, 8);
    try { localStorage.setItem(UI_KEYS.qHistory, JSON.stringify(h)); } catch {}
  }
  function clearSearchHistory() {
    try { localStorage.removeItem(UI_KEYS.qHistory); } catch {}
  }
  loadUiPrefs();

  const find = (id) => db.projects.find((p) => p.id === id);
  const byStage = (k) => db.projects.filter((p) => p.stage === k && alive(p));
  const daysIn = (p) => Math.max(0, Math.floor((Date.now() - Date.parse(p.stageChangedAt)) / DAY));
  const isStale = (p) => Boolean(STAGES[p.stage].staleDays) && daysIn(p) >= STAGES[p.stage].staleDays;
  const isLocked = (p) => NEXT[p.stage].length === 0;
  const canMove = (from, to) => from !== to && NEXT[from].includes(to);
  const lastNote = (p) => (p.history.length ? p.history[p.history.length - 1].note || '' : '');
  const hasQl = (p) => Boolean(p.qlNo);
  const docOf = (p, id) => (p.docs || {})[id] || null;

  // Kategori ditampilkan sebagai "Tipe · Kategori".
  const typeLabel = (p) => (p.subtype ? `${p.type} · ${p.subtype}` : p.type || '—');

  function can(cap, p = null) {
    if (!(CAN[cap] || []).includes(user.role)) return false;
    if (user.role === 'user' && p && OWNER_ONLY.has(cap)) return (p.owners || []).includes(user.id);
    return true;
  }

  function denyReason(cap, p = null) {
    if (user.role === 'user' && p && OWNER_ONLY.has(cap) && (CAN[cap] || []).includes('user')) {
      return 'Hanya PIC project ini yang bisa melakukannya.';
    }
    return `Hanya role ${roleNames(cap)} yang bisa melakukannya. Role Anda: ${ROLE_LABEL[user.role]}.`;
  }

  const dealOf = (p) => p.dealValue || p.offer || 0;

  // ---------------------------------------------------------------------------
  // Client: satu daftar tersendiri, dipakai berulang oleh banyak project.
  // Project hanya menyimpan clientId, jadi memperbarui data client cukup
  // sekali dan langsung berlaku di semua project miliknya.
  // ---------------------------------------------------------------------------
  const NO_CLIENT = { id: '', name: '—', pic: '', wa: '', email: '', notes: '' };
  const clientById = (id) => db.clients.find((c) => c.id === id) || null;
  const clientOf = (p) => clientById(p.clientId) || NO_CLIENT;
  const normName = (s) => String(s || '').trim().toLowerCase();
  const clientByName = (name) => db.clients.find((c) => normName(c.name) === normName(name)) || null;
  const projectsOfClient = (id) => aliveProjects().filter((p) => p.clientId === id);

  function newClientId() {
    let id;
    do {
      id = `c-${Math.random().toString(36).slice(2, 10)}`;
    } while (clientById(id));
    return id;
  }

  // Dipakai saat menyimpan project: pakai client yang sudah ada bila namanya
  // sama, dan perbarui kontaknya bila yang diisi berbeda.
  function upsertClient({ name, pic, wa, email }) {
    const existing = clientByName(name);
    if (existing) {
      if (pic) existing.pic = pic;
      if (wa) existing.wa = wa;
      if (email) existing.email = email;
      existing.name = String(name).trim(); // ikut ejaan terbaru
      return existing;
    }
    const c = {
      id: newClientId(),
      name: String(name).trim(),
      pic: pic || '',
      wa: wa || '',
      email: email || '',
      notes: '',
      createdAt: new Date().toISOString(),
      createdBy: user.id,
    };
    db.clients.push(c);
    return c;
  }

  // ID project: PROJECT- + 6 karakter acak huruf dan angka, mis. PROJECT-7K4PX9. Bisa dicari.
  // ID lama PRJ-xxxx tetap terbaca, tidak dimigrasi.
  function nextId() {
    let id = '';
    do {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let code = '';
      for (let i = 0; i < 6; i += 1) code += chars[Math.floor(Math.random() * chars.length)];
      id = `PROJECT-${code}`;
    } while (find(id));
    return id;
  }

  // Nomor QL berurutan per tipe project, mis. MGQL-0003.
  // Nomor di preview hanya perkiraan. Nomor final dihitung ulang saat simpan
  // dari data tersimpan terbaru, supaya bentrok antar tab tidak terjadi.
  const peekQlNo = (type) => `${qlPrefix(type)}-${String((db.qlSeq[type] || 0) + 1).padStart(4, '0')}`;

  // Ambil data terbaru dari localStorage sebelum alokasi.
  function syncQlSeq(type) {
    try {
      const fresh = AlurStore.loadData();
      const freshSeq = fresh.qlSeq && fresh.qlSeq[type] ? fresh.qlSeq[type] : 0;
      if (freshSeq > (db.qlSeq[type] || 0)) db.qlSeq[type] = freshSeq;
      // Gabung nomor terpakai dari data terbaru, biar loop di bawah lompat.
      (fresh.projects || []).forEach((p) => {
        if (p.qlNo && !db.projects.some((x) => x.id === p.id)) {
          // jangan timpa objek aktif; cukup tandai nomornya terpakai via seq
        }
      });
      return fresh;
    } catch { return null; }
  }

  function takeQlNo(type) {
    const fresh = syncQlSeq(type);
    const used = new Set(db.projects.map((p) => p.qlNo).filter(Boolean));
    if (fresh && fresh.projects) fresh.projects.forEach((p) => { if (p.qlNo) used.add(p.qlNo); });
    let no = '';
    let guard = 0;
    do {
      db.qlSeq[type] = (db.qlSeq[type] || 0) + 1;
      no = `${qlPrefix(type)}-${String(db.qlSeq[type]).padStart(4, '0')}`;
      guard += 1;
    } while (used.has(no) && guard < 10000);
    return no;
  }

  // Kunci lintas tab (Web Locks API) supaya dua tab yang klik simpan
  // barengan tidak dapat nomor sama. Tanpa dukungan, jalan langsung.
  async function withQlLock(fn) {
    if (navigator.locks && typeof navigator.locks.request === 'function') {
      return navigator.locks.request('alur-ql-alloc', { mode: 'exclusive' }, fn);
    }
    return fn();
  }

  function blockedReason(from, to) {
    if (from === 'deal') return 'Project Deal sudah final dan tidak bisa dipindah ke mana pun.';
    if (from === 'lost') return 'Project Tidak Deal sudah final dan tidak bisa dipindah lagi.';
    if (from === 'lead' && to === 'deal') return 'Lead harus melewati Proses QL sebelum bisa Deal.';
    return `Tidak bisa dipindah ke ${STAGES[to].label}.`;
  }

  // ---------------------------------------------------------------------------
  // Elemen
  // ---------------------------------------------------------------------------
  const sidebarEl = $('#sidebar');
  const scrimEl = $('#sidebar-scrim');
  const sideMenuEl = $('#side-menu');
  const railEl = $('#rail');
  const primaryBtn = $('#btn-primary');
  const viewEl = $('#view');
  const searchEl = $('#search');
  const dlgForm = $('#dlg-form');
  const formEl = $('#project-form');
  const dlgQl = $('#dlg-ql');
  const qlFormEl = $('#ql-form');
  const dlgUser = $('#dlg-user');
  const userFormEl = $('#user-form');
  const dlgBulkUser = $('#dlg-bulk-user');
  const bulkUserForm = $('#bulk-user-form');
  const dlgConfirm = $('#dlg-confirm');
  const dlgDetail = $('#dlg-detail');
  const detailEl = $('#detail-content');
  const toastRegion = $('#toast-region');

  // Pilihan form yang berasal dari master data: dibangun ulang tiap master berubah.
  function renderMasterOptions() {
    const selSrc = $('#f-source').value;
    $('#f-source').innerHTML = `<option value="">Pilih sumber lead</option>${
      LEAD_SOURCES.map((s) => `<option${s === selSrc ? ' selected' : ''}>${esc(s)}</option>`).join('')}`;
    if (selSrc) $('#f-source').value = selSrc;
    const selType = (formEl.querySelector('input[name="ptype"]:checked') || {}).value || '';
    $('#f-type-group').innerHTML = PROJECT_TYPES.map((t) => `
      <label class="chip">
        <input type="radio" name="ptype" value="${esc(t.name)}"${t.name === selType ? ' checked' : ''}>
        <span>${esc(t.name)}</span>
      </label>`).join('');
    const selEnt = (formEl.querySelector('input[name="pent"]:checked') || {}).value || '';
    $('#f-ent-group').innerHTML = ENTITIES.map((e) => `
      <label class="chip chip--ent">
        <input type="radio" name="pent" value="${esc(e.code)}"${e.code === selEnt ? ' checked' : ''}>
        <span><b class="mono">${esc(e.code)}</b>${esc(e.name)}</span>
      </label>`).join('');
  }
  renderMasterOptions();

  $('#f-lead-group').innerHTML = LEAD_KINDS.map((k) => `
    <label class="pick-opt pick-opt--${k.id}">
      <input type="radio" name="lead" value="${k.id}">
      <span class="pick-body">
        <span class="pick-title">${k.label}</span>
        <span class="pick-desc">${esc(k.desc)}</span>
      </span>
    </label>`).join('');

  $('#q-status-group').innerHTML = QL_STATUS.map((s) => `
    <label class="pick-opt">
      <input type="radio" name="qlstatus" value="${s.id}">
      <span class="pick-body">
        <span class="pick-title">${esc(s.label)}</span>
        <span class="pick-desc">${esc(s.desc)}</span>
      </span>
    </label>`).join('');

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  function render() {
    renderSide();
    renderRail();
    renderTopbar();
    renderView();
    if (dlgDetail.open) renderDetail();
  }

  // Sidebar hanya berisi menu halaman. Tab tahap ada di halaman Pipeline Project.
  function renderSide() {
    const items = [
      { page: 'project', label: 'Pipeline Project', icon: 'layers', count: aliveProjects().length },
      { page: 'clients', label: 'Clients', icon: 'building', count: db.clients.length },
      { page: 'report', label: 'Laporan', icon: 'chart', count: '' },
      { page: 'staff', label: 'Karyawan', icon: 'users', count: team.length },
      ...(can('masterData') ? [{ page: 'master', label: 'Master Data', icon: 'sliders', count: '' }] : []),
    ];
    const href = {
      project: '#/semua', clients: '#/clients', report: '#/laporan', staff: '#/karyawan', master: '#/master-data',
    };
    sideMenuEl.innerHTML = `<p class="side-label">Menu</p>${items.map((m) => `
      <a class="side-item" href="${href[m.page]}" data-page="${m.page}"
         ${ui.page === m.page ? 'aria-current="page"' : ''}>
        ${icon(m.icon)}
        <span class="side-item-label">${m.label}</span>
        ${m.count === '' ? '' : `<span class="side-item-count">${m.count}</span>`}
      </a>`).join('')}`;

    $('#me-avatar').textContent = initials(user.name);
    $('#me-name').textContent = user.name;
    $('#me-mail').textContent = '@' + user.username;
    $('#me-role').className = `role role--${user.role}`;
    $('#me-role').textContent = ROLE_LABEL[user.role];
  }

  // Tab tahap: jumlah project saja, tanpa nominal. Diletakkan di tengah.
  function renderRail() {
    railEl.hidden = ui.page !== 'project';
    if (railEl.hidden) {
      railEl.innerHTML = '';
      return;
    }
    const parts = [railTab('all'), '<span class="rail-div" aria-hidden="true"></span>'];
    ['lead', 'ql', 'deal'].forEach((k, i) => {
      parts.push(railTab(k));
      if (i < 2) parts.push(`<span class="rail-arrow" aria-hidden="true">${icon('chevron')}</span>`);
    });
    parts.push('<span class="rail-div" aria-hidden="true"></span>', railTab('lost'));
    railEl.innerHTML = `<div class="rail-inner" role="tablist" aria-label="Tahap project">${parts.join('')}</div>`;
  }

  function railTab(k) {
    const on = ui.tab === k;
    const attrs = `type="button" role="tab" id="tab-${k}" aria-selected="${on}" aria-controls="view" tabindex="${on ? 0 : -1}" data-tab="${k}"`;
    if (k === 'all') {
      return `<button ${attrs} class="rail-tab">
        <span class="rail-top"><span class="rail-label">Semua Project</span></span>
        <span class="rail-bottom"><span class="rail-count">${aliveProjects().length}</span><span class="rail-unit">project</span></span>
      </button>`;
    }
    const s = STAGES[k];
    const lock = s.final ? `<span class="rail-lock" title="Tahap final">${icon('lock')}</span>` : '';
    return `<button ${attrs} class="rail-tab rail-tab--${k}">
      <span class="rail-top"><span class="sq sq--${k}"></span><span class="rail-label">${s.label}</span>${lock}</span>
      <span class="rail-bottom"><span class="rail-count">${byStage(k).length}</span><span class="rail-unit">project</span></span>
    </button>`;
  }

  // Pencarian dan tombol utama mengikuti halaman yang dibuka.
  function renderTopbar() {
    const page = ui.page;
    const primary = {
      staff: can('manageUsers') ? ['new-user', 'Karyawan Baru'] : null,
      clients: can('editClient') ? ['new-client', 'Client Baru'] : null,
      project: can('createProject') ? ['new', 'Project Baru'] : null,
      report: null,
      master: null,
    }[page];
    primaryBtn.hidden = !primary;
    if (primary) {
      primaryBtn.dataset.action = primary[0];
      $('#btn-primary-label').textContent = primary[1];
      primaryBtn.setAttribute('aria-label', primary[1]);
    }
    // Laporan dan Master Data punya kontrol sendiri, pencarian tidak dipakai.
    searchEl.closest('.search').hidden = page === 'report' || page === 'master';
    const hint = {
      staff: 'Cari karyawan berdasarkan nama, username, atau role',
      clients: 'Cari client berdasarkan nama, PIC, WhatsApp, atau email',
      project: 'Cari project, nomor QL, perusahaan, atau PIC',
      report: '',
      master: '',
    };
    searchEl.placeholder = hint[page] || '';
    searchEl.setAttribute('aria-label', hint[page] || 'Cari');
  }

  const activeCount = (uid) => aliveProjects().filter((p) => (p.stage === 'lead' || p.stage === 'ql')
    && (p.owners || []).includes(uid)).length;

  function renderView() {
    const custom = { staff: staffView, clients: clientsView, report: reportView, master: masterView };
    if (custom[ui.page]) {
      const labels = { staff: 'Karyawan', clients: 'Clients', report: 'Laporan', master: 'Master Data' };
      viewEl.removeAttribute('role');
      viewEl.removeAttribute('aria-labelledby');
      viewEl.setAttribute('aria-label', labels[ui.page]);
      viewEl.innerHTML = custom[ui.page]();
      return;
    }
    viewEl.setAttribute('role', 'tabpanel');
    viewEl.removeAttribute('aria-label');
    viewEl.setAttribute('aria-labelledby', `tab-${ui.tab}`);
    viewEl.innerHTML = ui.tab === 'all' ? allView() : stageView(ui.tab);
  }

  // ----- Halaman Laporan -----
  const REPORT_TABS = [
    { id: 'overview', label: 'Ringkasan' },
    { id: 'sales', label: 'Sales' },
    { id: 'prospect', label: 'Prospek' },
  ];
  const STAGE_COLOR = {
    lead: 'var(--lead)', ql: 'var(--ql)', deal: 'var(--deal)', lost: 'var(--lost)',
  };

  const dayOf = (iso) => String(iso || '').slice(0, 10);
  const inRange = (iso, from, to) => {
    const d = dayOf(iso);
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  };
  // Project dihitung masuk sebuah tahap bila riwayatnya mencatat perpindahan
  // ke tahap itu di dalam rentang tanggal. Jadi laporan per periode akurat.
  const enteredIn = (p, stage, from, to) => p.history
    .some((h) => h.stage === stage && inRange(h.at, from, to));

  // ---------------------------------------------------------------------------
  // Export Excel .xlsx asli (OOXML + ZIP store, tanpa library).
  // Modern: cover branded, header navy, zebra, freeze pane, AutoFilter,
  // print setup landscape fit-to-width, angka Rp + tanggal native Excel.
  // ---------------------------------------------------------------------------
  const xmlEsc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  const sheetName = (s) => String(s || 'Sheet').replace(/[\\/?*\[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet';
  const colLetter = (n) => { let s = ''; let x = n; while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26); } return s; };

  // ZIP "store" (tanpa kompresi): cukup untuk xlsx, nol dependency.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files) {
    const enc = new TextEncoder();
    const chunks = []; const central = []; let offset = 0;
    const u16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
    const u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
    files.forEach(({ name, content }) => {
      const nameB = enc.encode(name);
      const data = typeof content === 'string' ? enc.encode(content) : content;
      const crc = crc32(data);
      const local = new Uint8Array([
        ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameB.length), ...u16(0),
      ]);
      chunks.push(local, nameB, data);
      central.push({ nameB, crc, size: data.length, offset });
      offset += local.length + nameB.length + data.length;
    });
    let cdSize = 0;
    central.forEach((c) => {
      const rec = new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
        ...u32(c.crc), ...u32(c.size), ...u32(c.size), ...u16(c.nameB.length),
        ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(c.offset),
      ]);
      chunks.push(rec, c.nameB); cdSize += rec.length + c.nameB.length;
    });
    chunks.push(new Uint8Array([
      ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
      ...u32(cdSize), ...u32(offset), ...u16(0),
    ]));
    return new Blob(chunks, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // Style index (lihat stylesXml): 0 normal,1 title,2 subtitle,3 header,
  // 4 text zebra,5 text,6 rupiah,7 rupiah zebra,8 angka,9 angka zebra,
  // 10 tanggal,11 tanggal zebra,12 persen,13 bold,14 total rupiah,15 total angka
  function stylesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
<numFmt numFmtId="164" formatCode="&quot;Rp&quot; #,##0"/>
<numFmt numFmtId="165" formatCode="dd mmm yyyy"/>
<numFmt numFmtId="166" formatCode="0%"/>
</numFmts>
<fonts count="5">
<font><sz val="10"/><name val="Calibri"/><color rgb="FF0E1A2B"/></font>
<font><b/><sz val="16"/><name val="Calibri"/><color rgb="FF0E1A2B"/></font>
<font><sz val="9"/><name val="Calibri"/><color rgb="FF6B7587"/></font>
<font><b/><sz val="10"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
<font><b/><sz val="10"/><name val="Calibri"/><color rgb="FF0E1A2B"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1D4FC4"/><bgColor rgb="FF1D4FC4"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5FB"/><bgColor rgb="FFF1F5FB"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE8EFFC"/><bgColor rgb="FFE8EFFC"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/></border>
<border><left style="thin"><color rgb="FFD9E1EC"/></left><right style="thin"><color rgb="FFD9E1EC"/></right><top style="thin"><color rgb="FFD9E1EC"/></top><bottom style="thin"><color rgb="FFD9E1EC"/></bottom></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="16">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right" vertical="top"/></xf>
<xf numFmtId="164" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"><alignment horizontal="right" vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment horizontal="right" vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"><alignment horizontal="right" vertical="top"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment vertical="top"/></xf>
<xf numFmtId="165" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"><alignment vertical="top"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right" vertical="top"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="4" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="right" vertical="top"/></xf>
<xf numFmtId="0" fontId="4" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="right" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  }

  const excelSerial = (iso) => {
    if (!iso) return '';
    const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return '';
    return Math.round((d.getTime() / 86400000) + 25569);
  };

  function colWidth(values, header, kind) {
    if (kind === 'rp') return 18;
    if (kind === 'date') return 14;
    if (kind === 'num') return 13;
    let max = String(header || '').length;
    values.forEach((v) => { max = Math.max(max, String(v ?? '').length); });
    return Math.min(46, Math.max(12, max + 2));
  }

  // Sheet data: baris 1 judul, 2 metadata, 3 kosong, 4 header, 5.. data, terakhir TOTAL bila ada kolom total.
  // columns: [{h, kind:'text|rp|num|date|pct', total?, get(row)}]
  function sheetXml({ title, subtitle, columns, rows, tabColor }) {
    const lastCol = colLetter(columns.length);
    const widths = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.w || colWidth(rows.map((r) => c.get(r)), c.h, c.kind)}" customWidth="1"/>`).join('');
    const sCell = (ref, style, v) => `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    let out = `<row r="1" ht="24" customHeight="1">${sCell(`A1`, 1, title)}</row>`;
    out += `<row r="2" ht="15" customHeight="1">${sCell('A2', 2, subtitle)}</row><row r="3" ht="6" customHeight="1"/>`;
    out += `<row r="4" ht="30" customHeight="1">${columns.map((c, i) => sCell(`${colLetter(i + 1)}4`, 3, c.h)).join('')}</row>`;
    rows.forEach((r, idx) => {
      const rn = idx + 5; const zebra = idx % 2 === 1;
      out += `<row r="${rn}">${columns.map((c, i) => {
        const ref = `${colLetter(i + 1)}${rn}`;
        const v = c.get(r);
        if (v === '' || v === null || v === undefined) {
          const st = zebra ? 4 : 5;
          return `<c r="${ref}" s="${st}"/>`;
        }
        if (c.kind === 'rp') return `<c r="${ref}" s="${zebra ? 7 : 6}"><v>${Number(v) || 0}</v></c>`;
        if (c.kind === 'num') return `<c r="${ref}" s="${zebra ? 9 : 8}"><v>${Number(v) || 0}</v></c>`;
        if (c.kind === 'pct') return `<c r="${ref}" s="12"><v>${(Number(v) || 0) / 100}</v></c>`;
        if (c.kind === 'date') { const s = excelSerial(v); return s === '' ? `<c r="${ref}" s="${zebra ? 4 : 5}"/>` : `<c r="${ref}" s="${zebra ? 11 : 10}"><v>${s}</v></c>`; }
        return sCell(ref, zebra ? 4 : 5, v);
      }).join('')}</row>`;
    });
    let totalRow = '';
    if (rows.length && columns.some((c) => c.total)) {
      const rn = rows.length + 5;
      totalRow = `<row r="${rn}">${columns.map((c, i) => {
        const ref = `${colLetter(i + 1)}${rn}`;
        if (i === 0) return sCell(ref, 13, 'TOTAL');
        if (!c.total) return `<c r="${ref}" s="13"/>`;
        const sum = rows.reduce((s, r) => s + (Number(c.get(r)) || 0), 0);
        return `<c r="${ref}" s="${c.kind === 'rp' ? 14 : 15}"><v>${sum}</v></c>`;
      }).join('')}</row>`;
    }
    const endRow = rows.length + (totalRow ? 5 : 4);
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><tabColor rgb="${tabColor || 'FF1D4FC4'}"/><pageSetupPr fitToPage="1"/></sheetPr>
<dimension ref="A1:${lastCol}${endRow}"/>
<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A5" sqref="A5"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths}</cols>
<sheetData>${out}${totalRow}</sheetData>
<autoFilter ref="A4:${lastCol}${Math.max(4, rows.length + 4)}"/>
<mergeCells count="2"><mergeCell ref="A1:${lastCol}1"/><mergeCell ref="A2:${lastCol}2"/></mergeCells>
<pageMargins left="0.35" right="0.35" top="0.5" bottom="0.5" header="0.25" footer="0.25"/>
<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
<headerFooter><oddFooter><center size="9" color="6B7587">Prasasti Group — Laporan Project &amp; Halaman &amp;P dari &amp;N</center></oddFooter></headerFooter>
</worksheet>`;
  }

  function buildWorkbook(sheets) {
    const files = [];
    files.push({ name: '[Content_Types].xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` });
    files.push({ name: '_rels/.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` });
    files.push({ name: 'xl/_rels/workbook.xml.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
    files.push({ name: 'xl/workbook.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="0"/><workbookPr codeName="PrasastiReport"/><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(sheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>` });
    files.push({ name: 'xl/styles.xml', content: stylesXml() });
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    files.push({ name: 'docProps/core.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Laporan Prasasti Group</dc:title><dc:creator>Prasasti Group — Project Management System</dc:creator><cp:lastModifiedBy>${xmlEsc(user.name)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` });
    files.push({ name: 'docProps/app.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Prasasti Group PMS</Application><TitlesOfParts><vt:vector xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes" size="${sheets.length}" baseType="lpstr">${sheets.map((s) => `<vt:lpstr>${xmlEsc(sheetName(s.name))}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts></Properties>` });
    sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, content: s.custom || sheetXml(s) }));
    return zipStore(files);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const stageAt = (p, stage) => {
    const h = p.history.filter((x) => x.stage === stage).pop();
    return h ? h.at : '';
  };
  const ownerNames = (p) => (p.owners || []).map(teamName).join(', ');

  // Cover khusus: bukan tabel, jadi dibangun manual (judul + KPI + isi workbook).
  function coverSheetXml({ period, stamp, kpi, sheetList }) {
    const sCell = (ref, style, v) => `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    let rows = '';
    rows += `<row r="1" ht="30" customHeight="1">${sCell('A1', 1, 'Prasasti Group — Laporan Project')}</row>`;
    rows += `<row r="2" ht="30" customHeight="1">${sCell('A2', 2, `Project Management System  •  Periode ${period}  •  Diekspor ${dTime.format(stamp)} oleh ${user.name} (${ROLE_LABEL[user.role]})`)}</row>`;
    rows += `<row r="3" ht="8" customHeight="1"/>`;
    rows += `<row r="4" ht="22" customHeight="1">${sCell('A4', 13, 'Ringkasan Utama (Periode Terpilih)')}</row>`;
    let rn = 5;
    kpi.forEach(([label, value, kind]) => {
      const val = kind === 'rp' ? `<c r="B${rn}" s="6"><v>${Number(value) || 0}</v></c>`
        : kind === 'num' && value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value))
          ? `<c r="B${rn}" s="8"><v>${Number(value) || 0}</v></c>`
          : sCell(`B${rn}`, 5, value);
      rows += `<row r="${rn}">${sCell(`A${rn}`, 5, label)}${val}</row>`; rn += 1;
    });
    rn += 1;
    rows += `<row r="${rn}" ht="22" customHeight="1">${sCell(`A${rn}`, 13, 'Isi Workbook')}</row>`; rn += 1;
    rows += `<row r="${rn}">${sCell(`A${rn}`, 3, 'Sheet')}${sCell(`B${rn}`, 3, 'Isi')}${sCell(`C${rn}`, 3, 'Jumlah Baris')}</row>`; rn += 1;
    sheetList.forEach(([name, desc, count]) => {
      const cnt = count === '' || count === null || count === undefined || !Number.isFinite(Number(count))
        ? sCell(`C${rn}`, 5, count)
        : `<c r="C${rn}" s="8"><v>${Number(count) || 0}</v></c>`;
      rows += `<row r="${rn}">${sCell(`A${rn}`, 5, name)}${sCell(`B${rn}`, 5, desc)}${cnt}</row>`; rn += 1;
    });
    rn += 1;
    const noteRow = rn;
    rows += `<row r="${noteRow}" ht="42" customHeight="1">${sCell(`A${noteRow}`, 2, 'Cara baca: angka Rp dan tanggal adalah nilai asli Excel (bisa di-sum / di-filter). Gunakan filter di baris header tiap sheet. Sheet per tahap menampilkan keadaan saat ini; sheet Ringkasan & Sales mengikuti periode filter Laporan.')}</row>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><tabColor rgb="FF0E1A2B"/><pageSetupPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>
<cols><col min="1" max="1" width="42" customWidth="1"/><col min="2" max="2" width="52" customWidth="1"/><col min="3" max="3" width="16" customWidth="1"/></cols>
<sheetData>${rows}</sheetData>
<mergeCells count="3"><mergeCell ref="A1:C1"/><mergeCell ref="A2:C2"/><mergeCell ref="A${noteRow}:C${noteRow}"/></mergeCells>
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5"/><pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="1"/></worksheet>`;
  }

  function buildReportSheets() {
    const { from, to } = ui.report;
    const period = !from && !to ? 'Semua waktu'
      : `${from ? dFull.format(parseDay(from)) : 'awal'} - ${to ? dFull.format(parseDay(to)) : 'sekarang'}`;
    const stamp = new Date();
    const meta = `Periode: ${period}  •  Diekspor: ${dTime.format(stamp)} oleh ${user.name} (${ROLE_LABEL[user.role]})`;
    const inPeriod = (p, stage) => enteredIn(p, stage, from, to);

    const projectCols = [
      { h: 'ID Project', w: 14, get: (p) => p.id },
      { h: 'Nomor QL', w: 14, get: (p) => p.qlNo || '—' },
      { h: 'Nama Project', w: 34, get: (p) => p.name },
      { h: 'Tahap', w: 15, get: (p) => STAGES[p.stage].label },
      { h: 'Tipe Project', w: 20, get: (p) => p.type || '—' },
      { h: 'Kategori', w: 20, get: (p) => p.subtype || '—' },
      { h: 'Entitas', w: 22, get: (p) => (p.entity ? `${p.entity} — ${entityName(p.entity)}` : '—') },
      { h: 'Client', w: 26, get: (p) => clientOf(p).name },
      { h: 'PIC Client', w: 18, get: (p) => clientOf(p).pic || '—' },
      { h: 'WhatsApp Client', w: 19, get: (p) => (clientOf(p).wa ? waPretty(clientOf(p).wa) : '—') },
      { h: 'Email Client', w: 24, get: (p) => clientOf(p).email || '—' },
      { h: 'PIC Project', w: 22, get: (p) => ownerNames(p) || '—' },
      { h: 'Jenis Lead', w: 11, get: (p) => (LEAD_BY_ID[p.lead] ? LEAD_BY_ID[p.lead].label : '—') },
      { h: 'Sumber Lead', w: 17, get: (p) => p.source || '—' },
      { h: 'Status QL', w: 19, get: (p) => (QL_BY_ID[p.qlStatus] ? QL_BY_ID[p.qlStatus].label : '—') },
      { h: 'Nilai Penawaran', kind: 'rp', total: 1, get: (p) => p.offer || 0 },
      { h: 'Nominal Deal', kind: 'rp', total: 1, get: (p) => (p.stage === 'deal' ? dealOf(p) : 0) },
      { h: 'Tgl Kegiatan Mulai', kind: 'date', get: (p) => p.start || '' },
      { h: 'Tgl Kegiatan Selesai', kind: 'date', get: (p) => p.end || p.start || '' },
      { h: 'Masuk Lead', kind: 'date', get: (p) => stageAt(p, 'lead') || p.createdAt || '' },
      { h: 'Masuk Proses QL', kind: 'date', get: (p) => stageAt(p, 'ql') },
      { h: 'Tanggal Deal', kind: 'date', get: (p) => stageAt(p, 'deal') },
      { h: 'Tanggal Tidak Deal', kind: 'date', get: (p) => stageAt(p, 'lost') },
      { h: 'Tanggal Dibuat', kind: 'date', get: (p) => p.createdAt || '' },
      { h: 'Dokumen Deal', w: 30, get: (p) => (p.stage === 'deal' ? DOCS.map((d) => `${d.label}: ${docOf(p, d.id) ? 'Ada' : 'Belum'}`).join('; ') : '—') },
      { h: 'Catatan Terakhir', w: 30, get: (p) => lastNote(p) || '—' },
      { h: 'Deskripsi', w: 36, get: (p) => p.desc || '—' },
    ];

    const dealInPeriod = aliveProjects().filter((p) => inPeriod(p, 'deal'));
    const dealValue = dealInPeriod.reduce((s, p) => s + dealOf(p), 0);
    const stats = reportStats();
    const byNow = (k) => aliveProjects().filter((p) => p.stage === k).sort((a, b) => (a.stageChangedAt < b.stageChangedAt ? 1 : -1));

    const dataSheets = [];
    const add = (name, title, columns, rows, tabColor) => dataSheets.push({ name, title, subtitle: meta, columns, rows, tabColor });

    add('Semua Project', 'Semua Project — Keadaan Saat Ini',
      projectCols, aliveProjects().slice().sort((a, b) => (a.stageChangedAt < b.stageChangedAt ? 1 : -1)), 'FF0E1A2B');
    const TAB = { lead: 'FF4A7BA8', ql: 'FFB7791F', deal: 'FF1F8A4C', lost: 'FFB03A2E' };
    ORDER.forEach((k) => add(STAGES[k].label, `${STAGES[k].label} — Keadaan Saat Ini (${byNow(k).length} project)`, projectCols, byNow(k), TAB[k]));

    add('Ringkasan per Tahap', 'Ringkasan per Tahap', [
      { h: 'Tahap', w: 22, get: (r) => r[0] },
      { h: 'Masuk pada Periode', kind: 'num', total: 1, get: (r) => r[1] },
      { h: 'Keadaan Saat Ini', kind: 'num', total: 1, get: (r) => r[2] },
    ], ORDER.map((k) => [STAGES[k].label, stats.byStageIn[k].length, byStage(k).length]), 'FF1D4FC4');

    add('Kinerja Sales', 'Kinerja Sales — Periode Terpilih', [
      { h: 'Karyawan', w: 24, get: (r) => r.u.name },
      { h: 'Username', w: 26, get: (r) => r.u.username },
      { h: 'Role', w: 13, get: (r) => ROLE_LABEL[r.u.role] },
      { h: 'Lead Masuk', kind: 'num', total: 1, get: (r) => r.lead },
      { h: 'Proses QL', kind: 'num', total: 1, get: (r) => r.ql },
      { h: 'Deal', kind: 'num', total: 1, get: (r) => r.deal },
      { h: 'Tidak Deal', kind: 'num', total: 1, get: (r) => r.lost },
      { h: 'Closing Rate', kind: 'pct', get: (r) => (r.rate === null ? '' : r.rate) },
      { h: 'Nilai Deal', kind: 'rp', total: 1, get: (r) => r.value },
    ], team.map((u) => {
      const mine = db.projects.filter((p) => (p.owners || []).includes(u.id));
      const c = {}; ORDER.forEach((k) => { c[k] = mine.filter((p) => enteredIn(p, k, from, to)).length; });
      const done = c.deal + c.lost;
      return { u, ...c, rate: done ? Math.round((c.deal / done) * 100) : null,
        value: mine.filter((p) => enteredIn(p, 'deal', from, to)).reduce((s, p) => s + dealOf(p), 0) };
    }).sort((a, b) => (b.deal - a.deal) || (b.ql - a.ql) || (b.lead - a.lead)), 'FF1D4FC4');

    const group = (name, title, rows, isRp) => add(name, title, [
      { h: 'Kategori', w: 38, get: (r) => r.label },
      { h: isRp ? 'Nilai Deal' : 'Jumlah Project', kind: isRp ? 'rp' : 'num', total: 1, get: (r) => r.value },
    ], rows, 'FF1D4FC4');
    group('Per Sumber Lead', 'Project per Sumber Lead — Lead Masuk Periode',
      LEAD_SOURCES.map((s) => ({ label: s, value: stats.leads.filter((p) => p.source === s).length })).sort((a, b) => b.value - a.value));
    group('Per Jenis Lead', 'Project per Jenis Lead — Lead Masuk Periode',
      LEAD_KINDS.map((k) => ({ label: k.label, value: stats.leads.filter((p) => p.lead === k.id).length })));
    group('Per Tipe Project', 'Project per Tipe Project — Lead Masuk Periode', typeRows(stats.leads));
    group('Per Kategori', 'Project per Kategori — Lead Masuk Periode', catRows(stats.leads));
    group('Per Entitas', 'Project per Entitas — Lead Masuk Periode', entityRows(stats.leads));
    group('Deal per Tipe', 'Nilai Deal per Tipe Project — Periode', typeRows(dealInPeriod, (p) => dealOf(p)), 1);
    group('Deal per Kategori', 'Nilai Deal per Kategori — Periode', catRows(dealInPeriod, (p) => dealOf(p)), 1);
    group('Deal per Entitas', 'Nilai Deal per Entitas — Periode', entityRows(dealInPeriod, (p) => dealOf(p)), 1);

    add('Clients', 'Database Clients', [
      { h: 'Perusahaan', w: 30, get: (r) => r.c.name },
      { h: 'PIC Client', w: 20, get: (r) => r.c.pic || '—' },
      { h: 'WhatsApp', w: 19, get: (r) => (r.c.wa ? waPretty(r.c.wa) : '—') },
      { h: 'Email', w: 26, get: (r) => r.c.email || '—' },
      { h: 'Total Project', kind: 'num', total: 1, get: (r) => r.mine.length },
      { h: 'Lead Masuk', kind: 'num', get: (r) => r.count.lead },
      { h: 'Proses QL', kind: 'num', get: (r) => r.count.ql },
      { h: 'Deal', kind: 'num', get: (r) => r.count.deal },
      { h: 'Tidak Deal', kind: 'num', get: (r) => r.count.lost },
      { h: 'Total Nilai Deal', kind: 'rp', total: 1, get: (r) => r.value },
      { h: 'Terakhir Aktif', kind: 'date', get: (r) => r.last },
      { h: 'Catatan', w: 30, get: (r) => r.c.notes || '—' },
    ], db.clients.map((c) => {
      const mine = projectsOfClient(c.id);
      const count = {}; ORDER.forEach((k) => { count[k] = mine.filter((p) => p.stage === k).length; });
      return { c, mine, count, value: mine.filter((p) => p.stage === 'deal').reduce((s, p) => s + dealOf(p), 0),
        last: mine.map((p) => p.stageChangedAt).sort().pop() || '' };
    }).sort((a, b) => b.mine.length - a.mine.length || a.c.name.localeCompare(b.c.name, 'id')), 'FF6B4FA1');

    add('Riwayat Tahap', 'Riwayat Perpindahan Tahap', [
      { h: 'ID Project', w: 14, get: (r) => r.p.id },
      { h: 'Nomor QL', w: 14, get: (r) => r.p.qlNo || '—' },
      { h: 'Nama Project', w: 32, get: (r) => r.p.name },
      { h: 'Client', w: 26, get: (r) => clientOf(r.p).name },
      { h: 'Masuk Tahap', w: 16, get: (r) => STAGES[r.h.stage].label },
      { h: 'Tanggal', kind: 'date', get: (r) => r.h.at },
      { h: 'Oleh', w: 20, get: (r) => (r.h.by ? teamName(r.h.by) : '—') },
      { h: 'Catatan', w: 36, get: (r) => r.h.note || '—' },
    ], aliveProjects().flatMap((p) => p.history.map((h) => ({ p, h })))
      .sort((a, b) => (a.h.at < b.h.at ? 1 : -1)), 'FF6B7587');

    const n = Object.fromEntries(ORDER.map((k) => [k, stats.byStageIn[k].length]));
    const done = n.deal + n.lost;
    const cover = {
      name: 'Cover', custom: coverSheetXml({
        period, stamp,
        kpi: [
          ['Lead Masuk (periode)', n.lead, 'num'],
          ['Proses QL (periode)', n.ql, 'num'],
          ['Deal (periode)', n.deal, 'num'],
          ['Tidak Deal (periode)', n.lost, 'num'],
          ['Closing Rate', done ? `${Math.round((n.deal / done) * 100)}%` : '—', 'text'],
          ['Total Nilai Deal (periode)', dealValue, 'rp'],
          ['Rata-rata Nilai Deal', dealInPeriod.length ? Math.round(dealValue / dealInPeriod.length) : 0, 'rp'],
          ['Total Project (saat ini, semua tahap)', db.projects.length, 'num'],
          ['Total Client', db.clients.length, 'num'],
          ['Total Karyawan', team.length, 'num'],
        ],
        sheetList: [
          ['Semua Project', 'Seluruh project, keadaan saat ini', db.projects.length],
          ...ORDER.map((k) => [STAGES[k].label, `Project tahap ${STAGES[k].label}, keadaan saat ini`, byStage(k).length]),
          ['Ringkasan per Tahap', 'Masuk periode vs keadaan saat ini', ORDER.length],
          ['Kinerja Sales', 'Per karyawan, periode terpilih', team.length],
          ['Per Sumber / Jenis / Tipe / Kategori / Entitas', '5 sheet: jumlah lead masuk periode, per dimensi', 5],
          ['Deal per Tipe / Kategori / Entitas', '3 sheet: nilai deal periode, per dimensi', 3],
          ['Clients', 'Database client + nilai deal', db.clients.length],
          ['Riwayat Tahap', 'Semua perpindahan tahap', db.projects.reduce((s, p) => s + p.history.length, 0)],
        ],
      }),
    };
    return [cover, ...dataSheets];
  }

  function exportExcel() {
    try {
      const sheets = buildReportSheets();
      downloadBlob(buildWorkbook(sheets), `Laporan-Prasasti-${todayISO()}.xlsx`);
      toast(`Excel (.xlsx) diekspor — ${sheets.length} sheet. Periode: ${ui.report.from || 'awal'} s/d ${ui.report.to || 'sekarang'}.`);
    } catch (err) {
      console.error('Export Excel gagal:', err);
      toast(`Gagal membuat Excel: ${err && err.message ? err.message : 'kesalahan tidak dikenal'}.`, { tone: 'warn' });
    }
  }

  function reportStats() {
    const { from, to } = ui.report;
    const byStageIn = {};
    ORDER.forEach((k) => { byStageIn[k] = aliveProjects().filter((p) => enteredIn(p, k, from, to)); });
    // Lead yang masuk pada periode ini jadi dasar laporan jenis dan sumber lead.
    const leads = byStageIn.lead;
    return { from, to, byStageIn, leads };
  }

  // Baris laporan per entitas perusahaan. Project lama yang belum punya entitas
  // tetap dihitung di bucket "Belum diisi" supaya total tidak bocor.
  function entityRows(list, valueOf = () => 1) {
    const rows = ENTITIES.map((e) => ({
      label: `${e.code} · ${e.name}`,
      value: list.filter((p) => p.entity === e.code).reduce((s, p) => s + valueOf(p), 0),
    }));
    const rest = list.filter((p) => !ENTITY_BY_CODE[p.entity]);
    if (rest.length) {
      rows.push({
        label: NO_ENTITY,
        value: rest.reduce((s, p) => s + valueOf(p), 0),
        color: 'var(--ink-3)',
      });
    }
    return rows.sort((a, b) => b.value - a.value);
  }

  // Baris laporan per kategori project. Dikelompokkan per tipe + kategori
  // supaya "Lainnya" dari tipe berbeda tidak tercampur dan kategori yatim
  // (sudah dihapus dari Master Data) tetap terlihat dengan penanda.
  const NO_CAT = 'Tanpa kategori';
  function catRows(list, valueOf = () => 1) {
    const sums = new Map();
    list.forEach((p) => {
      const orphan = Boolean(p.subtype) && subtypesOf(p.type).length
        && !subtypesOf(p.type).includes(p.subtype);
      const key = p.subtype ? `${p.type || '—'}|${p.subtype}` : '—| Tanpa kategori';
      const label = p.subtype
        ? (orphan ? `${p.type} · ${p.subtype} (yatim)` : `${p.type} · ${p.subtype}`)
        : NO_CAT;
      const cur = sums.get(key) || { label, value: 0, orphan };
      cur.value += valueOf(p);
      sums.set(key, cur);
    });
    return [...sums.values()]
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'id'));
  }

  // Baris laporan per tipe project. Lima tipe selalu ditampilkan, termasuk
  // yang masih nol, karena daftarnya tetap dan enak dibandingkan antar periode.
  function typeRows(list, valueOf = () => 1) {
    return PROJECT_TYPES
      .map((t) => ({
        label: t.name,
        value: list.filter((p) => p.type === t.name).reduce((s, p) => s + valueOf(p), 0),
      }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'id'));
  }

  // Bar horizontal berbasis CSS: lebih mudah dibaca dan ikut melebar sendiri.
  function repBars(items, { color = 'var(--primary)', empty = 'Belum ada data.' } = {}) {
    const max = Math.max(1, ...items.map((i) => i.value));
    const total = items.reduce((s, i) => s + i.value, 0);
    if (!total) return `<p class="rep-empty">${empty}</p>`;
    return `<ul class="rep-bars">${items.map((it) => `
      <li class="rep-bar-row">
        <span class="rep-bar-label">${esc(it.label)}</span>
        <span class="rep-bar-track">
          <span class="rep-bar-fill" style="width:${(it.value / max) * 100}%;background:${it.color || color}"></span>
        </span>
        <span class="rep-bar-val mono">${it.value}</span>
        <span class="rep-bar-pct mono">${total ? Math.round((it.value / total) * 100) : 0}%</span>
      </li>`).join('')}</ul>`;
  }

  // Varian rupiah: dipakai laporan prospek untuk tipe, kategori, dan entitas.
  function repBarsRp(rows, total, empty = 'Belum ada deal pada periode ini.') {
    if (!total) return `<p class="rep-empty">${empty}</p>`;
    const max = Math.max(1, ...rows.map((r) => r.value));
    return `<ul class="rep-bars rep-bars--rp">${rows.map((r) => `
      <li class="rep-bar-row">
        <span class="rep-bar-label">${esc(r.label)}</span>
        <span class="rep-bar-track">
          <span class="rep-bar-fill" style="width:${(r.value / max) * 100}%${r.color ? `;background:${r.color}` : ''}"></span>
        </span>
        <span class="rep-bar-val mono rep-bar-val--rp">${esc(rpShort(r.value))}</span>
        <span class="rep-bar-pct mono">${Math.round((r.value / total) * 100)}%</span>
      </li>`).join('')}</ul>`;
  }

  // Donut SVG. Tiap segmen digeser pakai stroke-dashoffset.
  function repDonut(parts, centerLabel, centerSub) {
    const size = 160;
    const thick = 20;
    const r = (size - thick) / 2;
    const c = 2 * Math.PI * r;
    const total = parts.reduce((s, p) => s + p.value, 0);
    let acc = 0;
    const segs = total
      ? parts.filter((p) => p.value > 0).map((p) => {
        const dash = (p.value / total) * c;
        const seg = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
          stroke="${p.color}" stroke-width="${thick}"
          stroke-dasharray="${dash.toFixed(2)} ${(c - dash).toFixed(2)}"
          stroke-dashoffset="${(c - acc).toFixed(2)}"
          transform="rotate(-90 ${size / 2} ${size / 2})"></circle>`;
        acc += dash;
        return seg;
      }).join('')
      : `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="${thick}"></circle>`;

    return `<div class="rep-donut">
      <svg viewBox="0 0 ${size} ${size}" class="rep-donut-svg" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${p.value}`).join(', '))}">
        ${segs}
        <text x="${size / 2}" y="${size / 2 - 2}" class="rep-donut-num">${esc(centerLabel)}</text>
        <text x="${size / 2}" y="${size / 2 + 16}" class="rep-donut-sub">${esc(centerSub)}</text>
      </svg>
      <ul class="rep-legend">${parts.map((p) => `
        <li>
          <span class="rep-dot" style="background:${p.color}"></span>
          <span class="rep-legend-label">${esc(p.label)}</span>
          <span class="rep-legend-val mono">${p.value}</span>
          <span class="rep-legend-pct mono">${total ? Math.round((p.value / total) * 100) : 0}%</span>
        </li>`).join('')}</ul>
    </div>`;
  }

  function reportView() {
    const { from, to } = ui.report;
    const label = !from && !to ? 'Semua waktu'
      : `${from ? dFull.format(parseDay(from)) : 'awal'} – ${to ? dFull.format(parseDay(to)) : 'sekarang'}`;

    const presets = [
      ['30', '30 hari'], ['90', '90 hari'], ['year', 'Tahun ini'], ['all', 'Semua'],
    ];

    const head = `<header class="view-head">
      <p class="stage-kicker mono">Laporan</p>
      <h1 class="view-title">${icon('chart', 'title-ic')}Laporan</h1>
      <p class="view-desc">Dihitung dari riwayat perpindahan tahap, jadi angka tiap periode mengikuti kapan project benar-benar masuk tahap tersebut.</p>
    </header>

    <div class="rep-filter">
      <div class="rep-filter-dates">
        <label class="rep-date">
          <span class="rep-date-label">Dari tanggal</span>
          <input type="date" id="rep-from" value="${esc(from)}">
        </label>
        <label class="rep-date">
          <span class="rep-date-label">Sampai tanggal</span>
          <input type="date" id="rep-to" value="${esc(to)}">
        </label>
      </div>
      <div class="rep-filter-presets">
        ${presets.map(([id, t]) => `<button type="button" class="btn btn-sm" data-range="${id}">${t}</button>`).join('')}
      </div>
      <button type="button" class="btn btn-primary" data-action="export-excel">${icon('download')} Export Excel (.xlsx)</button>
      <p class="rep-period">Periode: <b>${esc(label)}</b></p>
    </div>

    <div class="rep-tabs" role="tablist" aria-label="Bagian laporan">
      ${REPORT_TABS.map((t) => `
        <button type="button" role="tab" class="rep-tab" data-rtab="${t.id}"
                aria-selected="${ui.report.tab === t.id}" tabindex="${ui.report.tab === t.id ? 0 : -1}">${t.label}</button>`).join('')}
    </div>`;

    const body = ui.report.tab === 'sales' ? repSales()
      : ui.report.tab === 'prospect' ? repProspect() : repOverview();
    return `<section class="stage">${head}<div class="rep-body">${body}</div></section>`;
  }

  function repOverview() {
    const { byStageIn, leads } = reportStats();
    const n = Object.fromEntries(ORDER.map((k) => [k, byStageIn[k].length]));
    const done = n.deal + n.lost;

    const cards = [
      ['Lead Masuk', n.lead, 'lead', 'project masuk pipeline'],
      ['Proses QL', n.ql, 'ql', 'lead yang dikualifikasi'],
      ['Deal', n.deal, 'deal', 'disepakati client'],
      ['Tidak Deal', n.lost, 'lost', 'batal atau tidak lanjut'],
    ];

    // Corong: Lead -> QL -> Deal, dengan Tidak Deal sebagai cabang.
    const funnel = [
      { label: 'Lead Masuk', value: n.lead, color: STAGE_COLOR.lead },
      { label: 'Proses QL', value: n.ql, color: STAGE_COLOR.ql },
      { label: 'Deal', value: n.deal, color: STAGE_COLOR.deal },
      { label: 'Tidak Deal', value: n.lost, color: STAGE_COLOR.lost },
    ];
    const maxF = Math.max(1, ...funnel.map((f) => f.value));

    const conv = [
      ['Lead → Proses QL', n.lead ? Math.round((n.ql / n.lead) * 100) : 0],
      ['Proses QL → Deal', n.ql ? Math.round((n.deal / n.ql) * 100) : 0],
      ['Closing rate', done ? Math.round((n.deal / done) * 100) : 0],
    ];

    const kinds = LEAD_KINDS.map((k) => ({
      label: k.label,
      value: leads.filter((p) => p.lead === k.id).length,
      color: k.id === 'hot' ? '#c2560f' : '#4a7ba8',
    }));

    const sources = LEAD_SOURCES
      .map((s) => ({ label: s, value: leads.filter((p) => p.source === s).length }))
      .sort((a, b) => b.value - a.value);

    return `
      <dl class="rep-cards">${cards.map(([t, v, k, sub]) => `
        <div class="rep-card rep-card--${k}">
          <dt>${t}</dt>
          <dd>${v}</dd>
          <p class="rep-card-sub">${sub}</p>
        </div>`).join('')}</dl>

      <div class="rep-grid">
        <section class="panel panel--wide">
          <h2 class="panel-title">Corong pipeline</h2>
          <p class="panel-sub">Jumlah project yang masuk tiap tahap pada periode ini.</p>
          <ul class="rep-funnel">${funnel.map((f) => `
            <li>
              <span class="rep-funnel-label">${f.label}</span>
              <span class="rep-funnel-track">
                <span class="rep-funnel-fill" style="width:${(f.value / maxF) * 100}%;background:${f.color}"></span>
              </span>
              <span class="rep-funnel-val mono">${f.value}</span>
            </li>`).join('')}</ul>
          <dl class="rep-conv">${conv.map(([t, v]) => `
            <div><dt>${t}</dt><dd>${v}%</dd></div>`).join('')}</dl>
        </section>

        <section class="panel">
          <h2 class="panel-title">Jenis lead</h2>
          <p class="panel-sub">Dari lead yang masuk pada periode ini.</p>
          ${repDonut(kinds, String(leads.length), 'lead')}
        </section>
      </div>

      <section class="panel">
        <h2 class="panel-title">Sumber lead</h2>
        <p class="panel-sub">Asal lead yang masuk pada periode ini, diurutkan dari terbanyak.</p>
        ${repBars(sources, { empty: 'Belum ada lead masuk pada periode ini.' })}
      </section>

      <section class="panel">
        <h2 class="panel-title">Tipe project</h2>
        <p class="panel-sub">Tipe dari lead yang masuk pada periode ini.</p>
        ${repBars(typeRows(leads), { empty: 'Belum ada lead masuk pada periode ini.' })}
      </section>

      <section class="panel">
        <h2 class="panel-title">Kategori project</h2>
        <p class="panel-sub">Kategori dari lead yang masuk pada periode ini, diurutkan dari terbanyak.</p>
        ${repBars(catRows(leads), { empty: 'Belum ada lead masuk pada periode ini.' })}
      </section>

      <section class="panel">
        <h2 class="panel-title">Entitas perusahaan</h2>
        <p class="panel-sub">Badan usaha yang menjalankan lead yang masuk pada periode ini.</p>
        ${repBars(entityRows(leads), { empty: 'Belum ada lead masuk pada periode ini.' })}
      </section>`;
  }

  function repSales() {
    const { from, to } = ui.report;
    const rows = team.map((u) => {
      const mine = db.projects.filter((p) => (p.owners || []).includes(u.id));
      const c = {};
      ORDER.forEach((k) => { c[k] = mine.filter((p) => enteredIn(p, k, from, to)).length; });
      const done = c.deal + c.lost;
      return {
        u, ...c, done, rate: done ? Math.round((c.deal / done) * 100) : null,
        value: mine.filter((p) => enteredIn(p, 'deal', from, to))
          .reduce((s, p) => s + dealOf(p), 0),
      };
    }).sort((a, b) => (b.deal - a.deal) || (b.ql - a.ql) || (b.lead - a.lead));

    const any = rows.some((r) => r.lead || r.ql || r.deal || r.lost);
    const top = Math.max(1, ...rows.map((r) => r.lead));

    return `<section class="panel">
      <h2 class="panel-title">Kinerja per karyawan</h2>
      <p class="panel-sub">Semua akun ikut terhitung, apa pun rolenya. Project dengan beberapa PIC dihitung untuk tiap PIC, jadi jumlah kolom bisa lebih besar dari total project.</p>
      ${!any ? '<p class="rep-empty">Belum ada aktivitas pada periode ini.</p>' : `
      <div class="table-wrap">
        <table class="table table--sales">
          <thead><tr>
            <th class="c-name">Karyawan</th>
            <th class="c-role">Role</th>
            <th class="c-num">Lead Masuk</th>
            <th class="c-num">Proses QL</th>
            <th class="c-num">Deal</th>
            <th class="c-num">Tidak Deal</th>
            <th class="c-rate">Closing rate</th>
            <th class="c-offer">Nilai deal</th>
          </tr></thead>
          <tbody>${rows.map((r) => `
            <tr class="row is-flat">
              <td class="c-name" data-th="Karyawan">
                <span class="person">
                  <span class="avatar avatar--sm" aria-hidden="true">${esc(initials(r.u.name))}</span>
                  <span class="t-name">${esc(r.u.name)}${r.u.id === user.id ? ' <span class="muted">(Anda)</span>' : ''}</span>
                </span>
              </td>
              <td class="c-role" data-th="Role"><span class="role role--${r.u.role}">${esc(ROLE_LABEL[r.u.role])}</span></td>
              <td class="c-num" data-th="Lead Masuk">
                <span class="num${r.lead ? ' num--on' : ''}">${r.lead}</span>
                <span class="rep-mini"><span class="rep-mini-fill" style="width:${(r.lead / top) * 100}%"></span></span>
              </td>
              <td class="c-num" data-th="Proses QL"><span class="num">${r.ql}</span></td>
              <td class="c-num" data-th="Deal"><span class="num${r.deal ? ' is-paid' : ''}">${r.deal}</span></td>
              <td class="c-num" data-th="Tidak Deal"><span class="num">${r.lost}</span></td>
              <td class="c-rate" data-th="Closing rate">${r.rate === null
    ? '<span class="muted">—</span>'
    : `<span class="rep-rate"><span class="rep-rate-num mono">${r.rate}%</span>
         <span class="rep-mini"><span class="rep-mini-fill" style="width:${r.rate}%;background:var(--deal)"></span></span>
         <span class="t-sub">${r.deal} dari ${r.done} selesai</span></span>`}</td>
              <td class="c-offer" data-th="Nilai deal"><span class="mono${r.value ? '' : ' muted'}">${esc(rpShort(r.value))}</span></td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`}
    </section>`;
  }

  function repProspect() {
    const { from, to } = ui.report;
    const dealIn = db.projects.filter((p) => enteredIn(p, 'deal', from, to));
    const lostIn = db.projects.filter((p) => enteredIn(p, 'lost', from, to));
    // "Belum deal" adalah keadaan sekarang, dibatasi lead yang masuk pada periode.
    const openIn = db.projects.filter((p) => (p.stage === 'lead' || p.stage === 'ql')
      && enteredIn(p, 'lead', from, to));
    const hotOpen = openIn.filter((p) => p.lead === 'hot');
    const coldOpen = openIn.filter((p) => p.lead === 'cold');

    const dealValue = dealIn.reduce((s, p) => s + dealOf(p), 0);
    const avgDeal = dealIn.length ? Math.round(dealValue / dealIn.length) : 0;
    const biggest = dealIn.reduce((m, p) => Math.max(m, dealOf(p)), 0);
    const hotValue = hotOpen.reduce((s, p) => s + (p.offer || 0), 0);
    const lostValue = lostIn.reduce((s, p) => s + (p.offer || 0), 0);

    // Konversi menurut jenis lead: hot memang harus lebih tinggi dari cold.
    const byKind = LEAD_KINDS.map((k) => {
      const all = db.projects.filter((p) => p.lead === k.id && enteredIn(p, 'lead', from, to));
      const won = all.filter((p) => p.stage === 'deal').length;
      const closed = all.filter((p) => p.stage === 'deal' || p.stage === 'lost').length;
      return {
        label: k.label, all: all.length, won, closed,
        rate: closed ? Math.round((won / closed) * 100) : null,
        color: k.id === 'hot' ? '#c2560f' : '#4a7ba8',
      };
    });

    const byType = typeRows(dealIn, (p) => dealOf(p));

    const byCat = catRows(dealIn, (p) => dealOf(p));
    const byEntity = entityRows(dealIn, (p) => dealOf(p));

    const watch = hotOpen
      .slice()
      .sort((a, b) => (b.offer || 0) - (a.offer || 0))
      .slice(0, 8);

    return `
      <dl class="rep-cards rep-cards--3">
        <div class="rep-card rep-card--deal">
          <dt>Nilai deal</dt>
          <dd class="mono">${esc(rpShort(dealValue))}</dd>
          <p class="rep-card-sub">${dealIn.length} project · rata-rata ${rpShort(avgDeal)} · terbesar ${rpShort(biggest)}</p>
        </div>
        <div class="rep-card rep-card--hot">
          <dt>Prospect yang belum deal</dt>
          <dd>${hotOpen.length}</dd>
          <p class="rep-card-sub">potensi ${rpShort(hotValue)} · masih di Lead Masuk atau Proses QL</p>
        </div>
        <div class="rep-card rep-card--lost">
          <dt>Tidak Deal</dt>
          <dd>${lostIn.length}</dd>
          <p class="rep-card-sub">${lostValue ? `Prospect yang lepas ${rpShort(lostValue)}` : 'tanpa nilai Prospect tercatat'}</p>
        </div>
      </dl>

      <div class="rep-grid">
        <section class="panel">
          <h2 class="panel-title">Prospek yang masih terbuka</h2>
          <p class="panel-sub">Belum Deal dan belum Tidak Deal.</p>
          ${repDonut([
    { label: 'Hot', value: hotOpen.length, color: '#c2560f' },
    { label: 'Cold', value: coldOpen.length, color: '#4a7ba8' },
  ], String(openIn.length), 'terbuka')}
        </section>

        <section class="panel panel--wide">
          <h2 class="panel-title">Closing rate menurut jenis lead</h2>
          <p class="panel-sub">Dari lead yang sudah selesai, berapa persen yang jadi Deal.</p>
          <ul class="rep-kind">${byKind.map((k) => `
            <li>
              <span class="rep-kind-head">
                <span class="tag tag--${k.label.toLowerCase()}">${esc(k.label)}</span>
                <span class="rep-kind-rate">${k.rate === null ? '—' : `${k.rate}%`}</span>
              </span>
              <span class="rep-bar-track">
                <span class="rep-bar-fill" style="width:${k.rate || 0}%;background:${k.color}"></span>
              </span>
              <span class="rep-kind-sub">${k.all} lead masuk · ${k.won} Deal dari ${k.closed} selesai</span>
            </li>`).join('')}</ul>
        </section>
      </div>

      <section class="panel">
        <h2 class="panel-title">Nilai deal per tipe project</h2>
        <p class="panel-sub">Total nominal deal pada periode ini.</p>
        ${repBarsRp(byType, dealValue)}
      </section>

      <section class="panel">
        <h2 class="panel-title">Nilai deal per kategori</h2>
        <p class="panel-sub">Rincian nominal deal sampai ke kategori project.</p>
        ${repBarsRp(byCat, dealValue)}
      </section>

      <section class="panel">
        <h2 class="panel-title">Nilai deal per entitas perusahaan</h2>
        <p class="panel-sub">Total nominal deal pada periode ini, dibagi per badan usaha.</p>
        ${repBarsRp(byEntity, dealValue)}
      </section>

      ${watch.length ? `<section class="panel">
        <h2 class="panel-title">Prospect terbesar yang belum Deal</h2>
        <p class="panel-sub">Diurutkan dari nilai penawaran tertinggi.</p>
        <div class="table-wrap">
          <table class="table table--watch">
            <thead><tr>
              <th class="c-ql">Nomor</th>
              <th class="c-project">Project</th>
              <th class="c-stage">Tahap</th>
              <th class="c-offer">Penawaran</th>
              <th class="c-owner">PIC project</th>
            </tr></thead>
            <tbody>${watch.map((p) => `
              <tr class="row" data-id="${esc(p.id)}" tabindex="0">
                <td class="c-ql" data-th="Nomor"><span class="mono">${esc(p.qlNo || p.id)}</span></td>
                <td class="c-project" data-th="Project">
                  <span class="t-name">${esc(p.name)}</span>
                  <span class="t-sub">${esc(clientOf(p).name)}</span>
                </td>
                <td class="c-stage" data-th="Tahap"><span class="badge badge--${p.stage}">${STAGES[p.stage].label}</span></td>
                <td class="c-offer" data-th="Penawaran"><span class="mono${p.offer ? '' : ' muted'}">${p.offer ? esc(rpFull(p.offer)) : 'belum ada'}</span></td>
                <td class="c-owner" data-th="PIC project">${(p.owners || []).map(teamName).join(', ') || '—'}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
      </section>` : ''}`;
  }

  // ----- Daftar project -----
  function matches(p, q) {
    if (!q) return true;
    const c = clientOf(p);
    return [p.id, p.qlNo, p.name, p.entity, entityName(p.entity), p.type, p.subtype,
      c.name, c.pic, c.wa, c.email, p.source, p.desc]
      .concat((p.owners || []).map(teamName))
      .some((v) => String(v || '').toLowerCase().includes(q));
  }

  // ----- Filter, sorting, pagination daftar project -----
  const SORTS = [
    ['changed', 'Terbaru diubah'], ['created', 'Terbaru dibuat'], ['name', 'Nama project'],
    ['client', 'Nama client'], ['event', 'Tanggal kegiatan'], ['offer', 'Nilai penawaran / deal'],
  ];
  const subtypeOptions = () => [...new Set(db.projects.map((p) => p.subtype).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'id'));

  function listFiltered(stage) {
    const f = ui.list.filters;
    const q = ui.query.trim().toLowerCase();
    const source = aliveProjects();
    return source.filter((p) => {
      if (stage && p.stage !== stage) return false;
      if (!stage && f.stage && p.stage !== f.stage) return false;
      if (!matches(p, q)) return false;
      if (f.lead && p.lead !== f.lead) return false;
      if (f.type && p.type !== f.type) return false;
      if (f.subtype && p.subtype !== f.subtype) return false;
      if (f.entity && p.entity !== f.entity) return false;
      if (f.owner && !(p.owners || []).includes(f.owner)) return false;
      if (f.qlStatus && p.qlStatus !== f.qlStatus) return false;
      if (f.docs) {
        const ok = neededDocs(p.type).every((d) => docOf(p, d.id));
        if (f.docs === 'complete' && !ok) return false;
        if (f.docs === 'incomplete' && ok) return false;
      }
      if (f.from && dayOf(p.createdAt || p.stageChangedAt) < f.from) return false;
      if (f.to && dayOf(p.createdAt || p.stageChangedAt) > f.to) return false;
      return true;
    });
  }

  function sortProjects(list) {
    const { sortKey, sortDir } = ui.list;
    const val = (p) => {
      if (sortKey === 'name') return p.name.toLowerCase();
      if (sortKey === 'client') return clientOf(p).name.toLowerCase();
      if (sortKey === 'created') return p.createdAt || '';
      if (sortKey === 'event') return p.start || '9999-12-31';
      if (sortKey === 'offer') return p.stage === 'deal' ? dealOf(p) : (p.offer || 0);
      return p.stageChangedAt || '';
    };
    return list.slice().sort((a, b) => {
      const x = val(a); const y = val(b);
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y
        : String(x).localeCompare(String(y), 'id', { numeric: true });
      return cmp * sortDir || (a.stageChangedAt < b.stageChangedAt ? 1 : -1);
    });
  }

  function visible(stage) {
    return sortProjects(listFiltered(stage));
  }

  function activeFilterCount(stage) {
    const f = ui.list.filters;
    return Object.entries(f).filter(([k, v]) => v && !(stage && k === 'stage')).length;
  }

  function filterBar(stage) {
    const f = ui.list.filters;
    const sel = (id, label, opts, cur) => `<label class="flt"><span>${label}</span><select id="${id}" data-filter="${id}">
      <option value="">Semua</option>${opts.map(([v, t]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
    const subs = subtypeOptions();
    return `<section class="list-tools" aria-label="Filter dan urutan project">
      ${stage ? '' : sel('stage', 'Tahap', ORDER.map((k) => [k, STAGES[k].label]), f.stage)}
      ${sel('lead', 'Jenis lead', LEAD_KINDS.map((k) => [k.id, k.label]), f.lead)}
      ${sel('type', 'Tipe project', PROJECT_TYPES.map((t) => [t.name, t.name]), f.type)}
      ${subs.length ? sel('subtype', 'Kategori', subs.map((s) => [s, s]), f.subtype) : ''}
      ${sel('entity', 'Entitas', ENTITIES.map((e) => [e.code, `${e.code} - ${e.name}`]), f.entity)}
      ${sel('owner', 'PIC project', team.map((u) => [u.id, u.name]), f.owner)}
      ${sel('qlStatus', 'Status QL', QL_STATUS.map((s) => [s.id, s.label]), f.qlStatus)}
      ${sel('docs', 'Dokumen', [['complete', 'Lengkap'], ['incomplete', 'Belum lengkap']], f.docs)}
      <label class="flt"><span>Dibuat dari</span><input type="date" id="from" data-filter="from" value="${esc(f.from)}"></label>
      <label class="flt"><span>Dibuat sampai</span><input type="date" id="to" data-filter="to" value="${esc(f.to)}"></label>
      <label class="flt"><span>Urutkan</span><select id="sortKey" data-sort="key">
        ${SORTS.map(([v, t]) => `<option value="${v}"${v === ui.list.sortKey ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <button type="button" class="btn btn-sm flt-dir" data-action="sort-dir" aria-label="Balik arah urutan">${ui.list.sortDir === -1 ? 'Menurun ↓' : 'Naik ↑'}</button>
      <label class="flt"><span>Per halaman</span><select id="perPage" data-sort="perPage">
        ${[25, 50, 100].map((n) => `<option value="${n}"${n === ui.list.perPage ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      ${activeFilterCount(stage) ? `<button type="button" class="btn btn-sm" data-action="reset-filters">Reset filter (${activeFilterCount(stage)})</button>` : ''}
      <span class="flt-note">Filter tersimpan otomatis. Export Excel memakai filter laporan, bukan filter daftar ini.</span>
    </section>${searchHistoryHtml()}`;
  }

  function searchHistoryHtml() {
    const h = loadSearchHistory();
    if (!h.length) return '';
    return `<section class="list-tools list-tools--hist" aria-label="Riwayat pencarian">
      <span class="flt"><span>Riwayat pencarian</span></span>
      ${h.map((x) => `<button type="button" class="btn btn-sm" data-action="pick-history" data-q="${esc(x)}">${esc(x)}</button>`).join('')}
      <button type="button" class="btn btn-sm btn-ghost" data-action="clear-history">Hapus riwayat</button>
    </section>`;
  }

  function paginate(list, state) {
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / state.perPage));
    if (state.page > pages) state.page = pages;
    if (state.page < 1) state.page = 1;
    const start = (state.page - 1) * state.perPage;
    return { items: list.slice(start, start + state.perPage), total, pages, start };
  }

  function pagerHtml(state, total, pages, scope) {
    if (!total) return '';
    const from = (state.page - 1) * state.perPage + 1;
    const to = Math.min(total, state.page * state.perPage);
    const nums = [];
    for (let i = 1; i <= pages; i += 1) {
      if (pages <= 7 || i === 1 || i === pages || Math.abs(i - state.page) <= 1) nums.push(i);
      else if (nums[nums.length - 1] !== '...') nums.push('...');
    }
    return `<nav class="pager" aria-label="Halaman ${scope}">
      <span class="pager-info">Menampilkan ${from}-${to} dari ${nf.format(total)} ${scope}</span>
      <span class="pager-btns">
        <button type="button" class="btn btn-sm" data-page-nav="${scope}:prev"${state.page <= 1 ? ' disabled' : ''}>Sebelumnya</button>
        ${nums.map((n) => n === '...'
    ? '<span class="pager-gap">…</span>'
    : `<button type="button" class="btn btn-sm${n === state.page ? ' btn-primary' : ''}" data-page-nav="${scope}:${n}"${n === state.page ? ' aria-current="page"' : ''}>${n}</button>`).join('')}
        <button type="button" class="btn btn-sm" data-page-nav="${scope}:next"${state.page >= pages ? ' disabled' : ''}>Berikutnya</button>
      </span></nav>`;
  }

  function searchNote(count) {
    const q = ui.query.trim();
    if (!q) return '';
    return `<p class="search-note">${count} hasil untuk “${esc(q)}”<button type="button" class="link-btn" data-action="clear-search">Hapus pencarian</button></p>`;
  }

  function allView() {
    if (!aliveProjects().length) return onboarding();
    const items = visible();
    const pg = paginate(items, ui.list);
    const body = items.length
      ? table(pg.items, { showStage: true }) + pagerHtml(ui.list, pg.total, pg.pages, 'project')
      : '<div class="zero">Tidak ada project yang cocok dengan pencarian / filter.</div>';
    return `<header class="view-head">
        <h1 class="view-title">Semua Project</h1>
        <p class="view-desc">Seluruh project di empat tahap. Gunakan filter dan urutan untuk data besar.</p>
      </header>${searchNote(items.length)}${filterBar(null)}${body}`;
  }

  function onboarding() {
    return `<section class="onboard">
      <p class="onboard-kicker mono">Mulai</p>
      <h1 class="onboard-title">Belum ada project di pipeline.</h1>
      <p class="onboard-text">Project yang Anda input masuk ke <b>Lead Masuk</b>. Untuk lanjut ke <b>Proses QL</b>, status QL dan nilai penawaran wajib diisi, lalu nomor QL terbit otomatis sesuai tipe project.</p>
      <div class="onboard-actions">
        ${can('createProject') ? `<button type="button" class="btn btn-primary" data-action="new">${icon('plus')}Project Baru</button>
        <button type="button" class="btn" data-action="sample">Muat data contoh</button>` : ''}
      </div>
    </section>`;
  }

  function stageView(k) {
    const s = STAGES[k];
    const all = byStage(k);
    const items = visible(k);
    const stale = all.filter(isStale).length;

    const stats = [['Project', String(all.length)]];
    if (k === 'lead') {
      stats.push(['Hot', String(all.filter((p) => p.lead === 'hot').length), 'lead', 'hot']);
      stats.push(['Cold', String(all.filter((p) => p.lead === 'cold').length), 'lead', 'cold']);
    } else if (k === 'ql') {
      stats.push(['Sedang dikerjakan', String(all.filter((p) => p.qlStatus === 'proses').length), 'qlStatus', 'proses']);
      stats.push(['Sedang direview', String(all.filter((p) => p.qlStatus === 'review').length), 'qlStatus', 'review']);
      stats.push(['Belum dikerjakan', String(all.filter((p) => p.qlStatus === 'belum').length), 'qlStatus', 'belum']);
      stats.push(['Total penawaran', `<span class="mono stat-rp">${rpShort(all.reduce((t, p) => t + (p.offer || 0), 0))}</span>`]);
    } else if (k === 'deal') {
      stats.push(['Total nominal deal', `<span class="mono stat-rp">${rpShort(all.reduce((t, p) => t + dealOf(p), 0))}</span>`]);
      // Hanya tipe tertentu yang mewajibkan Quotation dan RAB.
      // Quotation wajib untuk semua tipe, jadi setiap project Deal ikut dihitung.
      const complete = all.filter((p) => neededDocs(p.type).every((d) => docOf(p, d.id))).length;
      const incomplete = all.length - complete;
      stats.push(['Dokumen lengkap', String(complete), 'docs', 'complete']);
      stats.push(['Dokumen belum lengkap', `<span class="${incomplete ? 'is-warn' : ''}">${incomplete}</span>`, 'docs', 'incomplete']);
    }

    const head = `<header class="view-head">
      <p class="stage-kicker mono">${s.final ? 'Tahap final' : `Tahap ${s.no}`}</p>
      <h1 class="view-title"><span class="sq sq--${k}"></span>${s.label}${s.final ? icon('lock', 'title-lock') : ''}</h1>
      <p class="view-desc">${s.desc}</p>
      <dl class="stage-stats">${stats.map(([t, v, fk, fv]) => {
        const on = fk ? ui.list.filters[fk] === fv : false;
        const dd = fk
          ? `<button type="button" class="stat-btn${on ? ' is-on' : ''}" data-action="filter-stat" data-filter="${esc(fk)}" data-value="${esc(fv)}" aria-pressed="${on}">${v}</button>`
          : v;
        return `<div><dt>${t}</dt><dd>${dd}</dd></div>`;
      }).join('')}</dl>
    </header>`;

    let body;
    if (!all.length) {
      body = `<div class="zero">${s.empty}${k === 'lead' && can('createProject')
        ? `<button type="button" class="btn btn-sm btn-primary" data-action="new">${icon('plus')}Project Baru</button>` : ''}</div>`;
    } else if (!items.length) {
      body = '<div class="zero">Tidak ada project yang cocok dengan pencarian / filter.</div>';
    } else {
      const pg = paginate(items, ui.list);
      body = table(pg.items, { stage: k }) + pagerHtml(ui.list, pg.total, pg.pages, 'project');
    }
    return `<section class="stage">${head}${searchNote(items.length)}${all.length ? filterBar(k) : ''}${body}</section>`;
  }

  // ----- Tabel project -----
  function table(items, { stage = null, showStage = false } = {}) {
    // Lead Masuk tanpa kolom ID: lihat ID di panel detail.
    const showQl = stage !== 'lead';
    const showId = stage !== 'lead' ? false : false; // kolom ID dihapus untuk Lead
    const showOffer = stage === 'ql' || stage === 'deal';
    const lastHead = stage === 'deal' ? 'Status' : stage === 'lost' ? 'Alasan batal' : 'Tindakan';
    const canDel = can('deleteProject');
    const allOnPage = canDel && items.length > 0 && items.every((p) => ui.selected.has(p.id));
    const cols = [
      canDel ? `<th class="c-sel"><input type="checkbox" data-select-all aria-label="Pilih semua project di halaman ini"${allOnPage ? ' checked' : ''}></th>` : '',
      showQl ? '<th class="c-ql">Nomor QL</th>' : '',
      '<th class="c-project">Project</th>',
      '<th class="c-type">Tipe project</th>',
      '<th class="c-cat">Kategori</th>',
      '<th class="c-ent">Entitas</th>',
      showStage ? '<th class="c-stage">Tahap</th>' : '',
      stage === 'ql' ? '<th class="c-qls">Status QL</th>' : '',
      showOffer ? `<th class="c-offer">${stage === 'deal' ? 'Nominal deal' : 'Nilai penawaran'}</th>` : '',
      '<th class="c-client">Client</th>',
      stage === 'ql' || stage === 'deal' ? '' : '<th class="c-lead">Lead</th>',
      '<th class="c-date">Tanggal kegiatan</th>',
      '<th class="c-owner">PIC project</th>',
      '<th class="c-age">Tanggal dibuat</th>',
      '<th class="c-docs">Dokumen</th>',
      `<th class="c-act">${lastHead}</th>`,
    ].join('');

    return `${bulkBar()}<div class="table-wrap">
      <table class="table">
        <thead><tr>${cols}</tr></thead>
        <tbody>${items.map((p) => row(p, { stage, showStage, showQl, showOffer, canDel })).join('')}</tbody>
      </table>
    </div>`;
  }

  // Toolbar hapus massal: hanya Manager/Admin (gerbang deleteProject).
  function bulkBar() {
    if (!can('deleteProject') || !ui.selected.size) return '';
    return `<div class="bulk-bar" role="region" aria-label="Aksi massal">
      <span class="bulk-count"><b>${ui.selected.size}</b> project dipilih</span>
      <span class="bulk-actions">
        <button type="button" class="btn btn-sm btn-danger" data-action="delete-selected">${icon('trash')}Hapus yang dipilih</button>
        <button type="button" class="btn btn-sm btn-ghost" data-action="clear-selection">Batal pilihan</button>
      </span>
    </div>`;
  }

  // Status dokumen per baris: Proses QL boleh unggah Quotation, RAB, Proposal,
  // Deal memakai aturan DOCS lengkap. Lead/Tidak Deal = belum waktunya.
  function docCell(p) {
    if (p.stage === 'ql') {
      const slots = DOCS.filter((d) => ['quotation', 'rab', 'proposal'].includes(d.id));
      const chips = slots.map((d) => {
        const f = docOf(p, d.id);
        const wajib = docNeeded(d, p.type);
        const cls = f ? 'doc-chip doc-chip--ok' : wajib ? 'doc-chip doc-chip--miss' : 'doc-chip doc-chip--opt';
        const mark = f ? icon('check') : wajib ? icon('x') : icon('file');
        const label = f ? d.label : wajib ? `${d.label} belum` : `${d.label} belum (opsional)`;
        return `<span class="${cls}" title="${esc(`${d.label}: ${f ? `sudah diunggah (${f.name})` : wajib ? 'wajib, belum diunggah' : 'opsional, belum diunggah'}`)}">${mark}${esc(label)}</span>`;
      }).join('');
      return `<div class="doc-chips">${chips}</div>`;
    }
    if (p.stage !== 'deal') return '<span class="doc-state doc-state--na">Belum waktunya</span>';
    const need = neededDocs(p.type);
    const missingNeed = need.filter((d) => !docOf(p, d.id));
    const head = missingNeed.length
      ? `<span class="doc-state doc-state--miss">${icon('alert')}Belum lengkap</span>`
      : `<span class="doc-state doc-state--ok">${icon('check')}Lengkap</span>`;
    const items = DOCS.map((d) => {
      const f = docOf(p, d.id);
      const wajib = docNeeded(d, p.type);
      const cls = f ? 'doc-chip doc-chip--ok' : wajib ? 'doc-chip doc-chip--miss' : 'doc-chip doc-chip--opt';
      const mark = f ? icon('check') : wajib ? icon('x') : icon('file');
      const label = f ? d.label : wajib ? `${d.label} belum` : `${d.label} belum (opsional)`;
      return `<span class="${cls}" title="${esc(`${d.label}: ${f ? `sudah diunggah (${f.name})` : wajib ? 'wajib, belum diunggah' : 'opsional, belum diunggah'}`)}">${mark}${esc(label)}</span>`;
    }).join('');
    return head + `<div class="doc-chips">${items}</div>`;
  }

  function row(p, { stage, showStage, showQl, showOffer, canDel }) {
    const when = eventWhen(p);
    const dash = '<span class="muted">—</span>';

    const created = `<span class="mono nowrap">${dFull.format(new Date(p.createdAt || p.stageChangedAt))}</span>`;

    let act;
    if (p.stage === 'deal') act = `<span class="lock-tag">${icon('lock')}Terkunci</span>`;
    else if (p.stage === 'lost') act = lastNote(p) ? `<span class="t-reason">${esc(lastNote(p))}</span>` : '<span class="muted">Tidak dicatat</span>';
    else act = `<div class="row-act">${moveButtons(p, 'btn-sm')}</div>`;

    const owners = p.owners || [];
    const ownerCell = owners.length
      ? `<span class="owner-text">${esc(owners.map(teamName).join(', '))}</span>`
      : dash;

    const idCell = showQl
      ? `<td class="c-ql" data-th="Nomor QL">${p.qlNo
        ? `<span class="ql-no mono">${esc(p.qlNo)}</span>`
        : `<span class="mono muted">${esc(p.id)}</span>`}</td>`
      : '';

    const qlStatus = QL_BY_ID[p.qlStatus];

    return `<tr class="row" data-id="${esc(p.id)}" tabindex="0" aria-label="${esc(`${p.qlNo || p.id}, ${p.name}. ${STAGES[p.stage].label}. Enter untuk detail.`)}">
      ${canDel ? `<td class="c-sel"><input type="checkbox" data-select="${esc(p.id)}" aria-label="Pilih ${esc(p.name)}"${ui.selected.has(p.id) ? ' checked' : ''}></td>` : ''}
      ${idCell}
      <td class="c-project" data-th="Project">
        <span class="t-name">${esc(p.name)}</span>
      </td>
      <td class="c-type" data-th="Tipe project">${p.type ? esc(p.type) : dash}</td>
      <td class="c-cat" data-th="Kategori">${p.subtype ? esc(p.subtype) : dash}</td>
      <td class="c-ent" data-th="Entitas">${p.entity
    ? `<span class="ent-code mono" title="${esc(entityName(p.entity))}">${esc(p.entity)}</span><span class="t-sub ent-name">${esc(entityName(p.entity))}</span>`
    : dash}</td>
      ${showStage ? `<td class="c-stage" data-th="Tahap"><span class="badge badge--${p.stage}">${STAGES[p.stage].label}</span></td>` : ''}
      ${stage === 'ql' ? `<td class="c-qls" data-th="Status QL">${qlStatus
    ? `<span class="qls qls--${qlStatus.id}">${icon(qlIcon(qlStatus.id))}${esc(qlStatus.label)}</span>` : dash}</td>` : ''}
      ${showOffer ? `<td class="c-offer" data-th="${p.stage === 'deal' ? 'Nominal deal' : 'Nilai penawaran'}">${(() => {
    // Setelah Deal, angka yang berlaku adalah nominal deal, bukan penawaran.
    const main = p.stage === 'deal' ? dealOf(p) : p.offer;
    if (!main) return dash;
    const shifted = p.stage === 'deal' && p.dealValue && p.offer && p.dealValue !== p.offer;
    return `<span class="mono offer">${esc(rpFull(main))}</span>${
      shifted ? `<span class="t-sub mono">penawaran ${esc(rpFull(p.offer))}</span>` : ''}`;
  })()}</td>` : ''}
      <td class="c-client" data-th="Client">
        <span class="t-main">${esc(clientOf(p).name)}</span>
      </td>
      ${stage === 'ql' || stage === 'deal' ? '' : `<td class="c-lead" data-th="Lead">
        <span class="tag tag--${p.lead || 'cold'}">${esc(LEAD_BY_ID[p.lead] ? LEAD_BY_ID[p.lead].label : '—')}</span>
        <span class="t-sub">${esc(p.source || '—')}</span>
      </td>`}
      <td class="c-date" data-th="Tanggal kegiatan">
        ${p.start
    ? `<span class="mono nowrap">${esc(eventRange(p))}</span>${
      when ? `<span class="t-sub when when--${when.tone}">${esc(when.text)}${eventDays(p) > 1 ? ` · ${eventDays(p)} hari` : ''}</span>` : ''}`
    : dash}
      </td>
      <td class="c-owner" data-th="PIC project">${ownerCell}</td>
      <td class="c-age" data-th="Tanggal dibuat">${created}</td>
      <td class="c-docs" data-th="Dokumen">${docCell(p)}</td>
      <td class="c-act" data-th="Tindakan">${act}</td>
    </tr>`;
  }

  function moveButtons(p, size = '') {
    return NEXT[p.stage].map((to) => {
      const cap = to === 'ql' ? 'moveToQl' : to === 'deal' ? 'moveToDeal' : 'moveToLost';
      const ok = can(cap, p);
      const attrs = ok
        ? `data-move="${to}" data-id="${esc(p.id)}"`
        : `disabled aria-disabled="true" title="${esc(denyReason(cap, p))}"`;
      return to === 'lost'
        ? `<button type="button" class="btn ${size} btn-quiet" ${attrs}>Tidak Deal</button>`
        : `<button type="button" class="btn ${size} btn-next" ${attrs}>${
          to === 'deal' ? 'Jadikan Deal' : 'Lanjut ke Proses QL'}${icon('arrow')}</button>`;
    }).join('');
  }

  // ----- Halaman Master Data (Admin) -----
  // Tipe/kategori/entitas/sumber lead dipakai form project, filter, dan
  // laporan. Item yang masih dipakai project tidak bisa dihapus, hanya
  // diganti namanya (project lama ikut nama baru karena dicocokkan per teks).
  const lines = (arr) => arr.join('\n');
  const usedCount = {
    type: (name) => db.projects.filter((p) => p.type === name).length,
    subtype: (s) => db.projects.filter((p) => p.subtype === s).length,
    entity: (code) => db.projects.filter((p) => p.entity === code).length,
    source: (s) => db.projects.filter((p) => p.source === s).length,
  };

  function masterView() {
    if (!can('masterData')) {
      return `<section class="stage"><div class="zero">Halaman Master Data hanya untuk role Admin. Role Anda: ${esc(ROLE_LABEL[user.role])}.</div></section>`;
    }
    const typeBlock = (t, i) => `<fieldset class="master-type" data-type-i="${i}">
      <div class="master-row">
        <label class="master-f">Nama tipe
          <input type="text" data-m="type-name" value="${esc(t.name)}" maxlength="60">
        </label>
        <label class="master-f master-f--sm">Awalan QL
          <input type="text" data-m="type-prefix" value="${esc(t.prefix)}" maxlength="8" class="mono">
        </label>
        <label class="check master-check"><input type="checkbox" data-m="type-rab"${t.rabRequired ? ' checked' : ''}><span>RAB wajib saat Deal</span></label>
        <span class="master-used">${usedCount.type(t.name)} project</span>
        <button type="button" class="btn btn-sm btn-text-danger" data-action="master-del-type" data-i="${i}">${icon('trash')}Hapus tipe</button>
      </div>
      <label class="master-f">Kategori (satu per baris, kosongkan bila tipe tanpa kategori)
        <textarea data-m="type-subs" rows="3">${esc(lines(t.subtypes))}</textarea>
      </label>
    </fieldset>`;
    const entBlock = (e, i) => `<div class="master-row" data-ent-i="${i}">
      <label class="master-f master-f--sm">Kode
        <input type="text" data-m="ent-code" value="${esc(e.code)}" maxlength="8" class="mono">
      </label>
      <label class="master-f">Nama entitas
        <input type="text" data-m="ent-name" value="${esc(e.name)}" maxlength="80">
      </label>
      <span class="master-used">${usedCount.entity(e.code)} project</span>
      <button type="button" class="btn btn-sm btn-text-danger" data-action="master-del-ent" data-i="${i}">${icon('trash')}Hapus entitas</button>
    </div>`;
    return `<section class="stage">
      <header class="view-head">
        <p class="stage-kicker mono">Pengaturan</p>
        <h1 class="view-title">Master Data</h1>
        <p class="view-desc">Tipe project, kategori, entitas, dan sumber lead yang dipakai form project, filter, dan laporan. Hanya Admin yang bisa membuka halaman ini. Mengganti nama item yang sudah dipakai ikut mengubah tampilan project lama; menghapus item yang masih dipakai ditolak.</p>
      </header>
      <form id="master-form" novalidate>
        <section class="panel master-panel">
          <div class="panel-head"><h2>Tipe project &amp; kategori</h2>
            <button type="button" class="btn btn-sm" data-action="master-add-type">${icon('plus')}Tambah tipe</button></div>
          <div id="master-types">${PROJECT_TYPES.map(typeBlock).join('')}</div>
        </section>
        <section class="panel master-panel">
          <div class="panel-head"><h2>Entitas perusahaan</h2>
            <button type="button" class="btn btn-sm" data-action="master-add-ent">${icon('plus')}Tambah entitas</button></div>
          <div id="master-ents">${ENTITIES.map(entBlock).join('')}</div>
        </section>
        <section class="panel master-panel">
          <div class="panel-head"><h2>Sumber lead</h2></div>
          <label class="master-f">Satu sumber per baris
            <textarea id="master-sources" rows="5">${esc(lines(LEAD_SOURCES))}</textarea>
          </label>
          <p class="master-note">Sumber yang dihapus dari daftar tetap tampil di project lama, hanya tidak bisa dipilih lagi.</p>
        </section>
        <section class="panel master-panel">
          <div class="panel-head"><h2>Riwayat versi</h2>
            <button type="button" class="btn btn-sm" data-action="master-reset">Reset ke default</button></div>
          <p class="panel-sub">Setiap simpan masuk riwayat (20 versi terakhir). Reset mengembalikan tipe/kategori/entitas/sumber bawaan; project lama tetap ikut nama baru lewat alur simpan normal.</p>
          ${db.masterHistory && db.masterHistory.length ? `<ul class="master-history">${db.masterHistory.slice().reverse().slice(0, 5).map((h) => `<li><span class="mono">${esc(dTime.format(new Date(h.at)))}</span> — ${esc(h.byName)} · Tipe ${h.types.length} · Entitas ${h.entities.length}</li>`).join('')}</ul>` : '<p class="muted">Belum ada riwayat. Simpan sekali dulu.</p>'}
        </section>
        <p class="form-alert" id="master-alert" role="alert"></p>
        <div class="master-foot">
          <button type="submit" class="btn btn-primary">Simpan master data</button>
        </div>
      </form>
    </section>`;
  }

  function masterAlert(msg) {
    const el = $('#master-alert');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-shown', Boolean(msg));
    if (msg) el.scrollIntoView({ block: 'nearest' });
  }

  // Baca editor jadi struktur master baru. idxMap memetakan baris editor
  // kembali ke item lama supaya ganti nama ikut memperbarui project lama.
  function readMasterForm() {
    const types = [...viewEl.querySelectorAll('[data-type-i]')].map((fs) => ({
      name: fs.querySelector('[data-m="type-name"]').value.trim(),
      prefix: fs.querySelector('[data-m="type-prefix"]').value.trim().toUpperCase(),
      rabRequired: fs.querySelector('[data-m="type-rab"]').checked,
      subtypes: fs.querySelector('[data-m="type-subs"]').value.split('\n').map((s) => s.trim()).filter(Boolean),
      _i: Number(fs.dataset.typeI),
    }));
    const entities = [...viewEl.querySelectorAll('[data-ent-i]')].map((row) => ({
      code: row.querySelector('[data-m="ent-code"]').value.trim().toUpperCase(),
      name: row.querySelector('[data-m="ent-name"]').value.trim(),
      _i: Number(row.dataset.entI),
    }));
    const sources = $('#master-sources').value.split('\n').map((s) => s.trim()).filter(Boolean);
    return { types, entities, sources };
  }

  function saveMaster(next) {
    const cleaned = {
      types: next.types.map(({ _i, ...t }) => t),
      entities: next.entities.map(({ _i, ...e }) => e),
      sources: next.sources,
    };

    // Ganti nama tipe dan kode entitas ikut memperbarui project lama.
    // Kategori yang dihapus ditolak bila masih dipakai (lihat guard submit).
    next.types.forEach((t) => {
      const old = PROJECT_TYPES[t._i];
      if (!old) return;
      if (old.name !== t.name) {
        db.projects.forEach((p) => { if (p.type === old.name) p.type = t.name; });
        if (db.qlSeq[old.name] !== undefined && db.qlSeq[t.name] === undefined) {
          db.qlSeq[t.name] = db.qlSeq[old.name];
          delete db.qlSeq[old.name];
        }
      }
    });
    next.entities.forEach((e) => {
      const old = ENTITIES[e._i];
      if (old && old.code !== e.code) {
        db.projects.forEach((p) => { if (p.entity === old.code) p.entity = e.code; });
      }
    });

    const snapshot = {
      at: new Date().toISOString(), by: user.id, byName: user.name,
      types: structuredClone(PROJECT_TYPES), entities: structuredClone(ENTITIES),
      sources: [...LEAD_SOURCES],
    };
    db.masterHistory.push(snapshot);
    if (db.masterHistory.length > 20) db.masterHistory = db.masterHistory.slice(-20);

    PROJECT_TYPES = cleaned.types;
    ENTITIES = cleaned.entities;
    LEAD_SOURCES = cleaned.sources;
    applyMaster();
    db.master = structuredClone(cleaned);
    audit('', 'master.update', `Tipe ${cleaned.types.length} · Entitas ${cleaned.entities.length} · Sumber ${cleaned.sources.length}`);
    save();
    renderMasterOptions();
  }

  function resetMaster() {
    const snapshot = {
      at: new Date().toISOString(), by: user.id, byName: user.name,
      types: structuredClone(PROJECT_TYPES), entities: structuredClone(ENTITIES),
      sources: [...LEAD_SOURCES],
    };
    db.masterHistory.push(snapshot);
    if (db.masterHistory.length > 20) db.masterHistory = db.masterHistory.slice(-20);
    PROJECT_TYPES = structuredClone(DEFAULT_TYPES);
    ENTITIES = structuredClone(DEFAULT_ENTITIES);
    LEAD_SOURCES = [...DEFAULT_SOURCES];
    applyMaster();
    db.master = structuredClone({ types: PROJECT_TYPES, entities: ENTITIES, sources: LEAD_SOURCES });
    audit('', 'master.reset', 'Reset ke default');
    save();
    renderMasterOptions();
  }

  // Baris editor baru memakai _i -1: tidak memetakan ke item lama mana pun.
  function masterAddRow(kind) {
    if (kind === 'type') {
      const box = $('#master-types');
      if (!box) return;
      box.insertAdjacentHTML('beforeend', `<fieldset class="master-type" data-type-i="-1">
        <div class="master-row">
          <label class="master-f">Nama tipe
            <input type="text" data-m="type-name" value="" maxlength="60">
          </label>
          <label class="master-f master-f--sm">Awalan QL
            <input type="text" data-m="type-prefix" value="" maxlength="8" class="mono">
          </label>
          <label class="check master-check"><input type="checkbox" data-m="type-rab"><span>RAB wajib saat Deal</span></label>
          <span class="master-used">0 project</span>
          <button type="button" class="btn btn-sm btn-text-danger" data-action="master-del-type">${icon('trash')}Hapus tipe</button>
        </div>
        <label class="master-f">Kategori (satu per baris, kosongkan bila tipe tanpa kategori)
          <textarea data-m="type-subs" rows="3"></textarea>
        </label>
      </fieldset>`);
      box.lastElementChild.querySelector('[data-m="type-name"]').focus();
    } else {
      const box = $('#master-ents');
      if (!box) return;
      box.insertAdjacentHTML('beforeend', `<div class="master-row" data-ent-i="-1">
        <label class="master-f master-f--sm">Kode
          <input type="text" data-m="ent-code" value="" maxlength="8" class="mono">
        </label>
        <label class="master-f">Nama entitas
          <input type="text" data-m="ent-name" value="" maxlength="80">
        </label>
        <span class="master-used">0 project</span>
        <button type="button" class="btn btn-sm btn-text-danger" data-action="master-del-ent">${icon('trash')}Hapus entitas</button>
      </div>`);
      box.lastElementChild.querySelector('[data-m="ent-code"]').focus();
    }
    masterAlert('');
  }
  // Reset bawaan tidak disediakan: mengembalikan nama bawaan bisa
  // mengyatimkan project yang tipenya sudah diganti nama. Ubah nama lewat
  // editor dan Simpan — jalur itu memperbarui project lama.

  // ----- Halaman Karyawan -----
  function staffView() {
    const q = ui.query.trim().toLowerCase();
    const list = team
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.username.includes(q)
        || ROLE_LABEL[u.role].toLowerCase().includes(q))
      .sort((a, b) => (a.id === user.id ? -1 : b.id === user.id ? 1 : a.name.localeCompare(b.name, 'id')));
    const admin = can('manageUsers');
    const byRole = AlurStore.ROLES.map((r) => [r.label, team.filter((u) => u.role === r.id).length]);

    const head = `<header class="view-head view-head--split">
      <div>
        <p class="stage-kicker mono">Tim</p>
        <h1 class="view-title">Karyawan</h1>
        <p class="view-desc">Akun karyawan dipakai untuk masuk ke aplikasi dan muncul sebagai pilihan PIC project. Role menentukan apa yang boleh dikerjakan.${
      admin ? '' : ' Hanya role Admin yang bisa membuat atau mengubah akun orang lain.'}</p>
        <dl class="stage-stats">
          <div><dt>Karyawan</dt><dd>${team.length}</dd></div>
          ${byRole.map(([l, n]) => `<div><dt>${l}</dt><dd>${n}</dd></div>`).join('')}
        </dl>
      </div>
      ${admin ? `<div class="view-head-actions">
        <button type="button" class="btn btn-primary" data-action="new-user">${icon('plus')}Buat akun karyawan</button>
        <button type="button" class="btn" data-action="new-bulk-user">Buat banyak</button>
      </div>` : ''}
    </header>`;

    const roleHelp = `<ul class="role-help">${AlurStore.ROLES.map((r) => `
      <li><span class="role role--${r.id}">${esc(r.label)}</span><span>${esc(r.desc)}</span></li>`).join('')}</ul>`;

    let body;
    if (!list.length) {
      body = `<div class="zero">Tidak ada karyawan yang cocok dengan “${esc(ui.query.trim())}”.</div>`;
    } else {
      body = `<div class="table-wrap">
        <table class="table table--staff">
          <thead><tr>
            <th class="c-name">Karyawan</th>
            <th class="c-email">Username</th>
            <th class="c-role">Role</th>
            <th class="c-num">Project aktif</th>
            <th class="c-num">Deal</th>
            <th class="c-num">Total sebagai PIC</th>
            <th class="c-created">Terdaftar</th>
            <th class="c-act">Aksi</th>
          </tr></thead>
          <tbody>${list.map((u) => staffRow(u, admin)).join('')}</tbody>
        </table>
      </div>`;
    }
    return `<section class="stage">${head}${q ? `<p class="search-note">${list.length} karyawan cocok dengan “${esc(ui.query.trim())}”<button type="button" class="link-btn" data-action="clear-search">Hapus pencarian</button></p>` : ''}${body}${roleHelp}</section>`;
  }

  function staffRow(u, admin) {
    const mine = aliveProjects().filter((p) => (p.owners || []).includes(u.id));
    const active = activeCount(u.id);
    const deals = mine.filter((p) => p.stage === 'deal').length;
    const isMe = u.id === user.id;
    const editable = admin || isMe;
    const inactive = Boolean(u.deletedAt);
    return `<tr class="row${editable ? '' : ' is-flat'}${inactive ? ' is-inactive' : ''}" data-user="${esc(u.id)}"
      ${editable ? 'tabindex="0"' : ''} aria-label="${esc(`${u.name}, username ${u.username}, role ${ROLE_LABEL[u.role]}${inactive ? ', nonaktif' : ''}.`)}">
      <td class="c-name" data-th="Karyawan">
        <span class="person">
          <span class="avatar avatar--sm" aria-hidden="true">${esc(initials(u.name))}</span>
          <span><span class="t-name">${esc(u.name)}</span>${isMe ? '<span class="t-sub">Akun Anda</span>' : ''}${inactive ? '<span class="t-sub is-warn">Nonaktif — tidak bisa login, data project tetap ada</span>' : ''}</span>
        </span>
      </td>
      <td class="c-email" data-th="Username"><span class="mono">${esc(u.username)}</span></td>
      <td class="c-role" data-th="Role"><span class="role role--${u.role}">${esc(ROLE_LABEL[u.role])}</span></td>
      <td class="c-num" data-th="Project aktif"><span class="num${active ? ' num--on' : ''}">${active}</span></td>
      <td class="c-num" data-th="Deal"><span class="num">${deals}</span></td>
      <td class="c-num" data-th="Total sebagai PIC"><span class="num">${mine.length}</span></td>
      <td class="c-created" data-th="Terdaftar"><span class="mono nowrap">${u.createdAt ? dFull.format(new Date(u.createdAt)) : '—'}</span></td>
      <td class="c-act" data-th="Aksi"><div class="row-act">
        ${editable ? `<button type="button" class="btn btn-sm" data-action="edit-user" data-id="${esc(u.id)}">${icon('edit')}${isMe ? 'Akun saya' : 'Edit akun'}</button>` : '<span class="muted">—</span>'}
        ${admin && !isMe ? (inactive
          ? `<button type="button" class="btn btn-sm btn-soft" data-action="restore-user" data-id="${esc(u.id)}">Aktifkan lagi</button>`
          : `<button type="button" class="btn btn-sm btn-quiet" data-action="deactivate-user" data-id="${esc(u.id)}">Nonaktifkan</button>`) : ''}
      </div></td>
    </tr>`;
  }

  // ----- Halaman Clients -----
  function clientsView() {
    const q = normName(ui.query);
    const cs = ui.clientList;
    let rows = db.clients.map((c) => {
      const mine = projectsOfClient(c.id);
      const count = {};
      ORDER.forEach((k) => { count[k] = mine.filter((p) => p.stage === k).length; });
      const value = mine.filter((p) => p.stage === 'deal').reduce((s, p) => s + dealOf(p), 0);
      const last = mine.map((p) => p.stageChangedAt).sort().pop() || '';
      return { c, mine, count, value, last };
    }).filter(({ c }) => !q || [c.name, c.pic, c.wa, c.email].some((v) => normName(v).includes(q)));
    if (cs.status === 'deal') rows = rows.filter((r) => r.count.deal > 0);
    else if (cs.status === 'repeat') rows = rows.filter((r) => r.mine.length > 1);
    else if (cs.status === 'idle') rows = rows.filter((r) => !r.mine.length);
    else if (cs.status === 'active') rows = rows.filter((r) => r.count.lead + r.count.ql > 0);
    const cval = (r) => {
      if (cs.sortKey === 'name') return r.c.name.toLowerCase();
      if (cs.sortKey === 'value') return r.value;
      if (cs.sortKey === 'last') return r.last || '';
      return r.mine.length;
    };
    rows.sort((a, b) => {
      const x = cval(a); const y = cval(b);
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y
        : String(x).localeCompare(String(y), 'id', { numeric: true });
      return cmp * cs.sortDir || a.c.name.localeCompare(b.c.name, 'id');
    });

    const withDeal = db.clients.filter((c) => projectsOfClient(c.id).some((p) => p.stage === 'deal')).length;
    const repeat = db.clients.filter((c) => projectsOfClient(c.id).length > 1).length;
    const idle = db.clients.filter((c) => !projectsOfClient(c.id).length).length;
    const allowed = can('editClient');

    const head = `<header class="view-head view-head--split">
      <div>
        <p class="stage-kicker mono">Database</p>
        <h1 class="view-title">${icon('building', 'title-ic')}Clients</h1>
        <p class="view-desc">Data client tersimpan sekali dan dipakai ulang. Saat input project, cukup pilih nama perusahaannya dan kontaknya terisi otomatis.</p>
        <dl class="stage-stats">
          <div><dt>Client</dt><dd>${db.clients.length}</dd></div>
          <div><dt>Pernah Deal</dt><dd>${withDeal}</dd></div>
          <div><dt>Repeat (&gt;1 project)</dt><dd>${repeat}</dd></div>
          <div><dt>Belum ada project</dt><dd>${idle}</dd></div>
        </dl>
      </div>
      ${allowed ? `<button type="button" class="btn btn-primary" data-action="new-client">${icon('plus')}Client Baru</button>` : ''}
    </header>`;

    const tools = db.clients.length ? `<section class="list-tools" aria-label="Filter dan urutan client">
      <label class="flt"><span>Status client</span><select id="c-status" data-cfilter="status">
        ${[['', 'Semua client'], ['active', 'Ada project aktif'], ['deal', 'Pernah Deal'], ['repeat', 'Repeat (>1 project)'], ['idle', 'Belum ada project']]
    .map(([v, t]) => `<option value="${v}"${v === cs.status ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="flt"><span>Urutkan</span><select id="c-sort" data-csort="key">
        ${[['projects', 'Jumlah project'], ['name', 'Nama client'], ['value', 'Nilai deal'], ['last', 'Terakhir aktif']]
    .map(([v, t]) => `<option value="${v}"${v === cs.sortKey ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <button type="button" class="btn btn-sm flt-dir" data-action="c-sort-dir">${cs.sortDir === -1 ? 'Menurun ↓' : 'Naik ↑'}</button>
      <label class="flt"><span>Per halaman</span><select id="c-perPage" data-csort="perPage">
        ${[25, 50, 100].map((n) => `<option value="${n}"${n === cs.perPage ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
    </section>` : '';

    let body;
    if (!db.clients.length) {
      body = '<div class="zero">Belum ada client. Client otomatis tersimpan saat Anda input project baru.</div>';
    } else if (!rows.length) {
      body = `<div class="zero">Tidak ada client yang cocok dengan pencarian / filter.</div>`;
    } else {
      const pg = paginate(rows, cs);
      body = `<div class="table-wrap">
        <table class="table table--clients">
          <thead><tr>
            <th class="c-name">Client</th>
            <th class="c-contact">Kontak</th>
            <th class="c-num">Project</th>
            <th class="c-stagemix">Sebaran tahap</th>
            <th class="c-offer">Nilai deal</th>
            <th class="c-date">Terakhir aktif</th>
            <th class="c-act">Aksi</th>
          </tr></thead>
          <tbody>${pg.items.map(clientRow).join('')}</tbody>
        </table>
      </div>${pagerHtml(cs, pg.total, pg.pages, 'client')}`;
    }
    return `<section class="stage">${head}${tools}${
      q ? `<p class="search-note">${rows.length} client cocok dengan “${esc(ui.query.trim())}”<button type="button" class="link-btn" data-action="clear-search">Hapus pencarian</button></p>` : ''
    }${body}</section>`;
  }

  function clientRow({ c, mine, count, value, last }) {
    const dash = '<span class="muted">—</span>';
    return `<tr class="row" data-client-row="${esc(c.id)}" tabindex="0"
      aria-label="${esc(`${c.name}, ${mine.length} project. Enter untuk detail client.`)}">
      <td class="c-name" data-th="Client">
        <span class="person">
          <span class="avatar avatar--sm" aria-hidden="true">${icon('building')}</span>
          <span>
            <span class="t-name">${esc(c.name)}</span>
            ${mine.length > 1 ? '<span class="t-sub">client berulang</span>' : ''}
          </span>
        </span>
      </td>
      <td class="c-contact" data-th="Kontak">
        <span class="t-main">${esc(c.pic || '—')}</span>
        ${waDigits(c.wa) ? `<span class="t-sub mono">${esc(waPretty(c.wa))}</span>` : ''}
        ${c.email ? `<span class="t-sub">${esc(c.email)}</span>` : ''}
      </td>
      <td class="c-num" data-th="Project"><span class="num${mine.length ? ' num--on' : ''}">${mine.length}</span></td>
      <td class="c-stagemix" data-th="Sebaran tahap">${mine.length
    ? `<span class="mix">${ORDER.filter((k) => count[k]).map((k) => `
          <span class="mix-item" title="${STAGES[k].label}">
            <span class="sq sq--${k}"></span>${count[k]}
          </span>`).join('')}</span>`
    : dash}</td>
      <td class="c-offer" data-th="Nilai deal"><span class="mono${value ? '' : ' muted'}">${esc(rpShort(value))}</span></td>
      <td class="c-date" data-th="Terakhir aktif">${last
    ? `<span class="mono nowrap">${dFull.format(new Date(last))}</span>` : dash}</td>
      <td class="c-act" data-th="Aksi">
        <button type="button" class="btn btn-sm" data-action="open-client" data-id="${esc(c.id)}">${icon('edit')}Detail</button>
      </td>
    </tr>`;
  }

  // ----- Panel detail -----
  function renderDetail() {
    const p = find(ui.detailId);
    if (!p) {
      if (dlgDetail.open) dlgDetail.close();
      return;
    }
    const s = STAGES[p.stage];
    const locked = isLocked(p);
    const dash = '<span class="muted">—</span>';
    const when = eventWhen(p);
    const kind = LEAD_BY_ID[p.lead];
    const qlStatus = QL_BY_ID[p.qlStatus];
    const cl = clientOf(p);

    const move = locked
      ? `<p class="lock-note lock-note--${p.stage}">${icon('lock')}<span>${p.stage === 'deal'
        ? 'Project sudah Deal. Tahap final: terkunci dan tidak bisa dipindah ke tahap lain.'
        : 'Project ditutup sebagai Tidak Deal. Tahap final: tidak bisa dipindah lagi.'}</span></p>`
      : `<div class="move-row">${moveButtons(p)}</div>`;

    const qlSection = hasQl(p) ? `<section class="d-sec">
        <h3>Proses QL</h3>
        <dl class="kv">
          <dt>Nomor QL</dt><dd><span class="ql-no ql-no--lg mono">${esc(p.qlNo)}</span></dd>
          <dt>Status QL</dt><dd>${qlStatus
    ? `<span class="qls qls--${qlStatus.id}">${icon(qlIcon(qlStatus.id))}${esc(qlStatus.label)}</span>${
      !locked && can('editQl', p) ? `<button type="button" class="link-btn link-btn--sm kv-inline" data-action="edit-ql" data-id="${esc(p.id)}">Update</button>` : ''}` : dash}</dd>
          <dt>Nilai penawaran</dt><dd><span class="mono offer offer--lg">${esc(rpFull(p.offer))}</span></dd>
          <dt>Masuk QL</dt><dd><span class="mono">${p.qlAt ? dTime.format(new Date(p.qlAt)) : '—'}</span></dd>
        </dl>
        ${p.qlNote ? `<p class="notes notes--sm">${esc(p.qlNote)}</p>` : ''}
      </section>` : '';

    // Nominal dan dokumen hanya ada setelah project jadi Deal.
    // Proses QL boleh sudah unggah Quotation & Proposal (downstream dibawa ke Deal).
    const qlDocSection = (p.stage === 'ql' && can('editDocs', p)) ? `<section class="d-sec" id="ql-docs">
        <div class="d-sec-head"><h3>Dokumen Proses QL</h3><span class="muted">${rabRequired(p.type) ? 'Prasasti Selaras: Quotation dan RAB wajib diunggah' : 'Quotation wajib diunggah, RAB opsional, Proposal selalu opsional'}</span></div>
        <ul class="doc-list">${['quotation', 'rab', 'proposal'].map((slot) => {
          const d = DOCS.find((x) => x.id === slot); const f = docOf(p, slot);
          const need = docNeeded(d, p.type);
          return `<li class="doc-item${f ? '' : ' is-empty'}">${icon('file')}
            <span class="doc-item-text"><span class="doc-item-label">${d.label}${need ? '' : ' <span class="opt">(opsional)</span>'}</span>
            ${f ? `<span class="doc-item-meta mono">${esc(f.name)} · ${fmtBytes(f.size)}</span>` : `<span class="doc-item-meta ${need ? 'is-warn' : 'muted'}">${need ? 'Belum diunggah' : 'Belum diunggah (opsional)'}</span>`}</span>
            ${f ? `<button type="button" class="btn btn-sm" data-preview-doc="${esc(p.id)}:${slot}">${icon('file')}Lihat</button>
            <button type="button" class="btn btn-sm" data-dl-doc="${esc(p.id)}:${slot}">${icon('download')}Unduh</button>` : ''}
          </li>`;
        }).join('')}</ul>
        <div class="move-row" style="margin-top:8px">
          <label class="btn btn-sm btn-soft"><input type="file" data-ql-doc="quotation" accept="${DOC_ACCEPT}" class="sr-only">${icon('upload')}Unggah Quotation</label>
          <label class="btn btn-sm"><input type="file" data-ql-doc="rab" accept="${DOC_ACCEPT}" class="sr-only">${icon('upload')}Unggah RAB</label>
          <label class="btn btn-sm"><input type="file" data-ql-doc="proposal" accept="${DOC_ACCEPT}" class="sr-only">${icon('upload')}Unggah Proposal</label>
        </div>
      </section>` : '';

    const dealSection = p.stage === 'deal' ? `<section class="d-sec">
        <div class="d-sec-head">
          <h3>Nominal &amp; dokumen</h3>
          ${can('editDocs', p) ? `<button type="button" class="link-btn link-btn--sm" data-action="edit-deal" data-id="${esc(p.id)}">Update</button>` : ''}
        </div>
        <dl class="kv">
          <dt>Nominal deal</dt><dd><span class="mono offer offer--lg">${esc(rpFull(p.dealValue || p.offer))}</span></dd>
          ${p.dealValue && p.offer && p.dealValue !== p.offer
    ? `<dt>Selisih penawaran</dt><dd><span class="mono">${p.dealValue > p.offer ? '+' : '−'}${esc(rpFull(Math.abs(p.dealValue - p.offer)))}</span></dd>` : ''}
        </dl>
        <ul class="doc-list">${DOCS.map((d) => {
    const f = docOf(p, d.id);
    const need = docNeeded(d, p.type);
    return `<li class="doc-item${f ? '' : ' is-empty'}">
            ${icon('file')}
            <span class="doc-item-text">
              <span class="doc-item-label">${d.label}${need ? '' : ' <span class="opt">(opsional)</span>'}</span>
              ${f
    ? `<span class="doc-item-meta mono">${esc(f.name)} · ${fmtBytes(f.size)}</span>`
    : `<span class="doc-item-meta ${need ? 'is-warn' : 'muted'}">${need ? 'Belum diunggah' : 'Tidak diunggah'}</span>`}
            </span>
            ${f ? `<button type="button" class="btn btn-sm" data-preview-doc="${esc(p.id)}:${d.id}">${icon('file')}Lihat</button>
            <button type="button" class="btn btn-sm" data-dl-doc="${esc(p.id)}:${d.id}">${icon('download')}Unduh</button>` : ''}
          </li>`;
  }).join('')}</ul>
      </section>` : '';

    const kv = [
      ['Tipe project', p.type ? esc(p.type) : dash],
      ...(p.subtype ? [['Kategori', esc(p.subtype)]] : []),
      ['Entitas perusahaan', p.entity
        ? `<b class="mono">${esc(p.entity)}</b> ${esc(entityName(p.entity))}` : dash],
      ['Tanggal kegiatan', p.start
        ? `<span class="mono">${esc(eventRange(p))}</span>${
          when ? `<span class="kv-sub when when--${when.tone}">${esc(when.text)} · ${eventDays(p)} hari</span>` : ''}`
        : '<span class="muted">Belum dijadwalkan</span>'],
      ['Jenis lead', kind ? `<span class="tag tag--${kind.id}">${kind.label}</span><span class="kv-sub">${esc(kind.desc)}</span>` : dash],
      ['Sumber lead', p.source ? esc(p.source) : dash],
      ['Dibuat', `<span class="mono">${dTime.format(new Date(p.createdAt || p.stageChangedAt))}</span>${
        p.createdBy ? `<span class="kv-sub">oleh ${esc(teamName(p.createdBy))}</span>` : ''}`],
      locked
        ? [`${s.label} sejak`, `<span class="mono">${dFull.format(new Date(p.stageChangedAt))}</span>`]
        : ['Di tahap ini', `<span class="${isStale(p) ? 'is-warn' : ''}">${ageText(daysIn(p))}</span>`],
    ];

    const clientKv = [
      ['Perusahaan', cl.id
        ? `${esc(cl.name)}<button type="button" class="link-btn link-btn--sm kv-inline" data-action="open-client" data-id="${esc(cl.id)}">Lihat client</button>`
        : esc(cl.name)],
      ['PIC client', cl.pic ? esc(cl.pic) : dash],
      ['WhatsApp', waDigits(cl.wa)
        ? `<a class="ext" href="${esc(waLink(cl.wa))}" target="_blank" rel="noopener">${icon('wa')}<span class="mono">${esc(waPretty(cl.wa))}</span></a>`
        : dash],
      ['Email', cl.email ? `<a class="ext" href="mailto:${esc(cl.email)}">${icon('mail')}<span>${esc(cl.email)}</span></a>` : dash],
      ['Total project client', cl.id
        ? `${projectsOfClient(cl.id).length} project${projectsOfClient(cl.id).length > 1 ? ' (termasuk yang ini)' : ''}`
        : dash],
    ];

    const owners = p.owners || [];
    const ownerList = owners.length
      ? `<ul class="owner-list">${owners.map((id) => `<li>
          <span class="avatar avatar--sm">${esc(initials(teamName(id)))}</span>
          <span>${esc(teamName(id))}${id === user.id ? ' <span class="muted">(Anda)</span>' : ''}${(team.find((u) => u.id === id) || {}).deletedAt ? ' <span class="is-warn">(nonaktif)</span>' : ''}</span>
        </li>`).join('')}</ul>`
      : '<p class="muted">Belum ada PIC project.</p>';

    const fieldHistory = p.history.map((h, i) => `<li>
        <span class="tl-mark sq--${h.stage}" aria-hidden="true"></span>
        <div>
          <p class="tl-stage">${i === 0 ? 'Masuk ke' : 'Pindah ke'} ${STAGES[h.stage].label}${
      h.qlNo ? ` · <span class="mono">${esc(h.qlNo)}</span>` : ''}</p>
          <time class="tl-time mono" datetime="${esc(h.at)}">${dTime.format(new Date(h.at))}</time>
          ${h.by ? `<p class="tl-by">oleh ${esc(teamName(h.by))}</p>` : ''}
          ${h.note ? `<p class="tl-note">${esc(h.note)}</p>` : ''}
        </div>
      </li>`).reverse().join('');

    const auditRows = db.audit.filter((a) => a.projectId === p.id).slice().reverse().slice(0, 50);
    const auditSection = auditRows.length ? `<section class="d-sec"><h3>Riwayat perubahan field</h3>
      <ol class="timeline">${auditRows.map((a) => `<li><span class="tl-mark" style="background:var(--primary)" aria-hidden="true"></span>
        <div><p class="tl-stage">${esc(a.action)}${a.detail ? ` — <span class="muted">${esc(a.detail)}</span>` : ''}</p>
        <time class="tl-time mono" datetime="${esc(a.at)}">${dTime.format(new Date(a.at))}</time>
        <p class="tl-by">oleh ${esc(a.byName || teamName(a.by))}</p></div></li>`).join('')}</ol></section>`
      : '<section class="d-sec"><h3>Riwayat perubahan field</h3><p class="muted">Belum ada perubahan tercatat.</p></section>';
    const history = fieldHistory;

    const hadFocus = dlgDetail.contains(document.activeElement);
    detailEl.innerHTML = `
      <header class="drawer-head">
        <div class="drawer-meta">
          <span class="mono">${esc(p.qlNo || p.id)}</span>
          ${p.qlNo ? `<span class="mono muted">ID ${esc(p.id)}</span>` : ''}
          <span class="badge badge--${p.stage}">${s.label}</span>
        </div>
        <button type="button" class="icon-btn" data-close aria-label="Tutup detail">${icon('x')}</button>
      </header>
      <div class="drawer-body">
        <h2 class="drawer-title" id="detail-title" tabindex="-1">${esc(p.name)}</h2>
        <p class="drawer-client">${esc(clientOf(p).name)} · <span class="mono muted">ID ${esc(p.id)}</span></p>

        <section class="d-sec"><h3>Tahap</h3>${move}</section>
        ${qlSection}
        ${qlDocSection}
        ${dealSection}
        <section class="d-sec"><h3>Data project</h3><dl class="kv">${
      kv.map(([t, v]) => `<dt>${t}</dt><dd>${v}</dd>`).join('')}</dl></section>
        <section class="d-sec"><h3>Informasi client</h3><dl class="kv">${
      clientKv.map(([t, v]) => `<dt>${t}</dt><dd>${v}</dd>`).join('')}</dl></section>
        ${p.desc ? `<section class="d-sec"><h3>Deskripsi</h3><p class="notes">${esc(p.desc)}</p></section>` : ''}
        <section class="d-sec"><h3>PIC project</h3>${ownerList}</section>
        <section class="d-sec"><h3>Riwayat tahap</h3><ol class="timeline">${history}</ol></section>
        ${auditSection}
      </div>
      <footer class="drawer-foot">
        ${can('deleteProject', p)
    ? `<button type="button" class="btn btn-text-danger" data-action="delete" data-id="${esc(p.id)}">${icon('trash')}Hapus</button>`
    : '<span></span>'}
        ${can('editProject', p)
    ? `<button type="button" class="btn" data-action="edit" data-id="${esc(p.id)}">${icon('edit')}Edit data</button>`
    : `<span class="foot-note">${esc(denyReason('editProject', p))}</span>`}
      </footer>`;
    if (dlgDetail.open && hadFocus && !dlgDetail.contains(document.activeElement)) {
      $('#detail-title').focus({ preventScroll: true });
    }
  }

  function openDetail(id) {
    if (!find(id)) return;
    ui.detailId = id;
    renderDetail();
    if (!dlgDetail.open) dlgDetail.showModal();
  }

  // ---------------------------------------------------------------------------
  // Pindah tahap
  // ---------------------------------------------------------------------------
  async function requestMove(id, to) {
    let p = find(id);
    if (!p || p.stage === to) return;
    if (!canMove(p.stage, to)) {
      toast(blockedReason(p.stage, to), { tone: 'warn' });
      return;
    }

    const cap = to === 'ql' ? 'moveToQl' : to === 'deal' ? 'moveToDeal' : 'moveToLost';
    if (!can(cap, p)) {
      toast(denyReason(cap, p), { tone: 'warn' });
      return;
    }

    // Lead -> Proses QL wajib lewat form status QL dan nilai penawaran.
    if (to === 'ql') {
      openQlForm(id);
      return;
    }

    // QL -> Deal wajib lewat form nominal deal dan dokumen.
    if (to === 'deal') {
      openDealForm(id);
      return;
    }

    const res = await confirmDialog({
      title: `Pindahkan ${p.qlNo || p.id} ke Tidak Deal?`,
      body: `“${p.name}” akan ditutup sebagai Tidak Deal. Tahap ini final.`,
      okLabel: 'Pindahkan ke Tidak Deal',
      tone: 'danger',
      reason: true,
    });
    p = find(id); // data bisa berubah saat dialog terbuka (tab lain)
    if (!res || !p || !canMove(p.stage, to)) return;
    applyMove(p, to, { note: res.reason });
    toast(`${p.qlNo || p.id} dipindah ke Tidak Deal.`);
  }

  function applyMove(p, to, { note = '', qlNo = '' } = {}) {
    const at = new Date().toISOString();
    const from = p.stage;
    p.stage = to;
    p.stageChangedAt = at;
    const entry = { stage: to, at, by: user.id };
    if (note) entry.note = note;
    if (qlNo) entry.qlNo = qlNo;
    p.history.push(entry);
    audit(p.id, `stage.${from}->${to}`, note || '');
    save();
    render();
    flash(p.id);
    return at;
  }

  function undoMove(id, to, at, prev) {
    const p = find(id);
    if (!p || p.stage !== to || p.stageChangedAt !== at) {
      toast('Tidak bisa diurungkan, project sudah berubah lagi.', { tone: 'warn' });
      return;
    }
    p.history.pop();
    p.stage = prev.stage;
    p.stageChangedAt = prev.at;
    save();
    render();
    flash(id);
    toast(`${p.qlNo || id} dikembalikan ke ${STAGES[prev.stage].label}. Nomor QL ${p.qlNo} tetap tersimpan.`);
  }

  function flash(id) {
    requestAnimationFrame(() => {
      viewEl.querySelectorAll(`.row[data-id="${CSS.escape(id)}"]`).forEach((el) => {
        el.classList.remove('is-arrived');
        void el.offsetWidth;
        el.classList.add('is-arrived');
        el.addEventListener('animationend', () => el.classList.remove('is-arrived'), { once: true });
        if (!dlgDetail.open) el.scrollIntoView({ block: 'nearest' });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Form QL: wajib sebelum masuk Proses QL, juga dipakai untuk mengubah status
  // ---------------------------------------------------------------------------
  const offerInput = $('#q-offer');

  function openQlForm(id, editing = false) {
    const p = find(id);
    if (!p) return;
    qlFormEl.reset();
    clearErr('q-status');
    clearErr('q-offer');
    qlFormEl.dataset.id = id;
    qlFormEl.dataset.editing = editing ? '1' : '';

    // Nomor QL hanya terbit sekali. Bila project sudah punya nomor (mis. pernah
    // masuk QL lalu diurungkan), nomor itu dipakai lagi, bukan nomor baru.
    const existing = hasQl(p);
    const no = existing ? p.qlNo : peekQlNo(p.type);

    $('#ql-title').textContent = editing ? `Update proses QL ${p.qlNo}` : 'Lanjut ke Proses QL';
    $('#ql-sub').innerHTML = editing
      ? `${esc(p.name)} · <b>${esc(p.type)}</b>`
      : `Isi status QL dan nilai penawaran lebih dulu. Setelah disimpan, <b>${esc(p.name)}</b> pindah ke Proses QL. Nomor final dihitung ulang saat simpan, bisa beda dari perkiraan bila user lain lebih dulu mengisi.`;
    $('.ql-preview-label').textContent = existing ? 'Nomor QL' : 'Nomor QL perkiraan (final dihitung saat simpan)';
    $('#ql-preview-no').textContent = no;
    $('#ql-preview-type').textContent = p.type ? `${p.type} · awalan ${qlPrefix(p.type)}` : '';
    $('#ql-submit').textContent = editing ? 'Simpan perubahan' : 'Simpan & pindahkan';

    // Isi data lama bila ada, supaya tidak perlu diketik ulang.
    if (p.qlStatus || p.offer) {
      qlFormEl.querySelectorAll('input[name="qlstatus"]').forEach((r) => { r.checked = r.value === p.qlStatus; });
      offerInput.value = p.offer ? nf.format(p.offer) : '';
      $('#q-note').value = p.qlNote || '';
    }
    dlgQl.showModal();
    (qlFormEl.querySelector('input[name="qlstatus"]:checked') || qlFormEl.querySelector('input[name="qlstatus"]')).focus();
  }

  offerInput.addEventListener('input', () => {
    const d = digitsOnly(offerInput.value).replace(/^0+(?=\d)/, '').slice(0, 15);
    offerInput.value = d ? nf.format(Number(d)) : '';
    clearErr('q-offer');
  });
  $('#q-status-group').addEventListener('change', () => clearErr('q-status'));

  qlFormEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = qlFormEl.dataset.id;
    const editing = Boolean(qlFormEl.dataset.editing);
    const status = (qlFormEl.querySelector('input[name="qlstatus"]:checked') || {}).value || '';
    const offer = Number(digitsOnly(offerInput.value)) || 0;
    const note = $('#q-note').value.trim();

    clearErr('q-status');
    clearErr('q-offer');
    const errs = [];
    if (!status) errs.push(['q-status', 'Pilih status QL: belum, sedang dikerjakan, atau di review.']);
    if (!offer) errs.push(['q-offer', 'Nilai penawaran wajib diisi dan lebih dari nol.']);
    if (errs.length) {
      errs.forEach(([f, m]) => setErr(f, m));
      focusField(errs[0][0]);
      return;
    }

    let p = find(id);
    if (!p) {
      dlgQl.close();
      return;
    }

    p.qlStatus = status;
    p.offer = offer;
    p.qlNote = note;

    if (editing) {
      audit(p.id, 'ql.update', `${status} · ${offer}`);
      save();
      dlgQl.close();
      render();
      toast(`Proses QL ${p.qlNo} diperbarui.`, { tone: 'ok' });
      return;
    }

    if (!canMove(p.stage, 'ql')) {
      dlgQl.close();
      toast(blockedReason(p.stage, 'ql'), { tone: 'warn' });
      return;
    }

    // Alokasi nomor di dalam kunci lintas tab: nomor final bisa beda dari preview.
    await withQlLock(() => {
      // Muat ulang data terbaru di dalam kunci, ambil ulang project karena data bisa berubah.
      try { const fresh = AlurStore.loadData(); if (fresh.projects) {
        const freshP = fresh.projects.find((x) => x.id === id);
        // Samakan stage/qlNo bila tab lain sudah memindahkannya.
        if (freshP && freshP.stage !== p.stage) { p.stage = freshP.stage; p.stageChangedAt = freshP.stageChangedAt; }
      } } catch {}
      if (!canMove(p.stage, 'ql')) return;
      const prev = { stage: p.stage, at: p.stageChangedAt };
      // Nomor QL hanya diterbitkan sekali, lalu melekat pada project.
      const isNew = !p.qlNo;
      if (isNew) p.qlNo = takeQlNo(p.type);
      p.qlAt = new Date().toISOString();
      const at = applyMove(p, 'ql', { note, qlNo: p.qlNo });
      dlgQl.close();
      if (ui.page !== 'project' || (ui.tab !== 'all' && ui.tab !== 'ql')) setTab('ql');
      flash(p.id);
      toast(`${p.name} masuk Proses QL dengan nomor ${p.qlNo}.`, {
        tone: 'ok',
        action: { label: 'Urungkan', icon: 'undo', run: () => undoMove(id, 'ql', at, prev) },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Form Deal: nominal wajib, Quotation & RAB wajib untuk Prasasti Selaras
  // ---------------------------------------------------------------------------
  const dlgDeal = $('#dlg-deal');
  const dealFormEl = $('#deal-form');
  const dealValue = $('#d-value');
  let dealDocs = {}; // { quotation: {id,name,size,type}, rab: {...} }
  let dealNewFiles = [];

  const fmtBytes = (n) => (n >= 1024 * 1024
    ? `${nf1.format(n / (1024 * 1024))} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  function renderDocFields(type) {
    $('#doc-fields').innerHTML = DOCS.map((d) => {
      const f = dealDocs[d.id];
      const need = docNeeded(d, type);
      return `<div class="doc">
        <div class="doc-head">
          <span class="doc-label">${d.label} ${need
        ? '<span class="req" aria-hidden="true">*</span>'
        : '<span class="opt">(opsional)</span>'}</span>
          ${f ? `<button type="button" class="link-btn link-btn--sm" data-doc-clear="${d.id}">Hapus</button>` : ''}
        </div>
        ${f
        ? `<p class="doc-file">${icon('file')}<button type="button" class="doc-name doc-name--link" data-doc-dl="${d.id}">${esc(f.name)}</button><span class="doc-size mono">${fmtBytes(f.size)}</span></p>`
        : `<label class="doc-drop">
             <input type="file" id="doc-${d.id}" data-doc="${d.id}" accept="${DOC_ACCEPT}">
             <span>${icon('upload')}Pilih berkas ${d.label}</span>
           </label>`}
      </div>`;
    }).join('');
  }

  function openDealForm(id, editing = false) {
    const p = find(id);
    if (!p) return;
    dealFormEl.reset();
    clearErr('d-value');
    clearErr('d-docs');
    dealFormEl.dataset.id = id;
    dealFormEl.dataset.editing = editing ? '1' : '';
    dealDocs = { ...(p.docs || {}) };
    dealNewFiles = [];

    const needRab = rabRequired(p.type);
    $('#deal-title').textContent = editing ? `Nominal & dokumen ${p.qlNo || p.id}` : `Jadikan ${p.qlNo || p.id} Deal`;
    $('#deal-sub').innerHTML = editing
      ? `${esc(p.name)} · <b>${esc(p.type)}</b>`
      : `“${esc(p.name)}” akan dikunci di tahap Deal dan tidak bisa dipindah lagi.`;
    $('#docs-rule').innerHTML = needRab
      ? `Quotation &amp; RAB <b>wajib</b> untuk ${esc(p.type)} · Proposal &amp; SPK opsional`
      : 'Quotation <b>wajib</b> · RAB, Proposal &amp; SPK opsional';
    $('#docs-rule').className = 'docs-rule docs-rule--need';
    $('#deal-submit').textContent = editing ? 'Simpan perubahan' : 'Simpan & jadikan Deal';
    dealValue.value = nf.format(p.dealValue || p.offer || 0);
    renderDocFields(p.type);
    dlgDeal.showModal();
    dealValue.focus();
    dealValue.select();
  }

  dealValue.addEventListener('input', () => {
    const d = digitsOnly(dealValue.value).replace(/^0+(?=\d)/, '').slice(0, 15);
    dealValue.value = d ? nf.format(Number(d)) : '';
    clearErr('d-value');
  });

  $('#deal-docs').addEventListener('change', async (e) => {
    const input = e.target.closest('[data-doc]');
    if (!input || !input.files || !input.files[0]) return;
    const file = input.files[0];
    const slot = input.dataset.doc;
    clearErr('d-docs');
    if (file.size > MAX_DOC_BYTES) {
      setErr('d-docs', `${file.name} berukuran ${fmtBytes(file.size)}, melebihi batas 10 MB.`);
      input.value = '';
      return;
    }
    try {
      const meta = await AlurStore.putFile(file);
      dealNewFiles.push(meta.id);
      dealDocs[slot] = meta;
      const p = find(dealFormEl.dataset.id);
      renderDocFields(p ? p.type : '');
    } catch (err) {
      setErr('d-docs', `Berkas gagal disimpan: ${err.message}`);
    }
  });

  $('#deal-docs').addEventListener('click', async (e) => {
    const clear = e.target.closest('[data-doc-clear]');
    if (clear) {
      const slot = clear.dataset.docClear;
      const meta = dealDocs[slot];
      if (meta && meta.id && dealNewFiles.includes(meta.id)) {
        AlurStore.deleteFiles([meta.id]);
        dealNewFiles = dealNewFiles.filter((x) => x !== meta.id);
      }
      delete dealDocs[slot];
      const p = find(dealFormEl.dataset.id);
      renderDocFields(p ? p.type : '');
      clearErr('d-docs');
      return;
    }
    const dl = e.target.closest('[data-doc-dl]');
    if (dl && !(await AlurStore.downloadFile(dealDocs[dl.dataset.docDl]))) {
      setErr('d-docs', 'Berkas tidak ditemukan di penyimpanan browser ini.');
    }
  });

  dealFormEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = dealFormEl.dataset.id;
    const editing = Boolean(dealFormEl.dataset.editing);
    const value = Number(digitsOnly(dealValue.value)) || 0;
    const p = find(id);
    if (!p) {
      dlgDeal.close();
      return;
    }

    clearErr('d-value');
    clearErr('d-docs');
    const errs = [];
    if (!value) errs.push(['d-value', 'Nominal deal wajib diisi dan lebih dari nol.']);
    const missing = neededDocs(p.type).filter((d) => !dealDocs[d.id]).map((d) => d.label);
    if (missing.length) {
      errs.push(['d-docs', `${missing.join(' dan ')} wajib diunggah sebelum project jadi Deal.`]);
    }
    if (errs.length) {
      errs.forEach(([f, m]) => setErr(f, m));
      focusField(errs[0][0]);
      return;
    }

    // Simpan dulu ke salinan, supaya bisa dibatalkan bila penyimpanan penuh.
    const before = { dealValue: p.dealValue, docs: p.docs };
    const at = new Date().toISOString();
    p.dealValue = value;
    p.docs = {};
    DOCS.forEach((d) => {
      if (!dealDocs[d.id]) return;
      const prev = (before.docs || {})[d.id];
      const same = prev && (prev.id === dealDocs[d.id].id);
      p.docs[d.id] = { ...dealDocs[d.id], at: same ? prev.at : at, by: same ? prev.by : user.id };
    });

    if (!trySave()) {
      p.dealValue = before.dealValue;
      p.docs = before.docs;
      setErr('d-docs', 'Penyimpanan browser penuh. Hapus data contoh lebih dulu.');
      return;
    }

    // Berkas lama yang diganti tidak perlu disimpan lagi.
    const keep = new Set(Object.values(p.docs).map((f) => f.id).filter(Boolean));
    AlurStore.deleteFiles(Object.values(before.docs || {})
      .map((f) => f.id).filter((id) => id && !keep.has(id)));
    dealNewFiles = [];

    if (editing) {
      dlgDeal.close();
      render();
      toast(`Nominal dan dokumen ${p.qlNo || p.id} diperbarui.`, { tone: 'ok' });
      return;
    }

    if (!canMove(p.stage, 'deal')) {
      dlgDeal.close();
      toast(blockedReason(p.stage, 'deal'), { tone: 'warn' });
      return;
    }
    applyMove(p, 'deal', { note: `Nominal deal ${rpFull(value)}` });
    dlgDeal.close();
    if (ui.page !== 'project' || (ui.tab !== 'all' && ui.tab !== 'deal')) setTab('deal');
    flash(p.id);
    toast(`${p.qlNo || p.id} resmi Deal senilai ${rpFull(value)} dan dikunci.`, { tone: 'ok' });
  });

  dlgDeal.addEventListener('close', () => {
    if (dealNewFiles.length) {
      AlurStore.deleteFiles(dealNewFiles);
      dealNewFiles = [];
    }
  });

  // ---------------------------------------------------------------------------
  // Dialog konfirmasi
  // ---------------------------------------------------------------------------
  const confirmOk = $('#confirm-ok');
  const reasonWrap = $('#confirm-reason-wrap');
  const reasonInput = $('#confirm-reason');
  const typeWrap = $('#confirm-type-wrap');
  const typeInput = $('#confirm-type');

  function confirmDialog({ title, body, okLabel, tone = 'primary', reason = false, requireText = '' }) {
    const needType = Boolean(requireText);
    return new Promise((resolve) => {
      $('#confirm-title').textContent = title;
      $('#confirm-body').textContent = body;
      reasonWrap.hidden = !reason;
      reasonInput.value = '';
      if (typeWrap) {
        typeWrap.hidden = !needType;
        if (needType) typeInput.value = '';
      }
      const errEl = $('#confirm-type-err');
      if (errEl) errEl.textContent = '';
      confirmOk.textContent = okLabel;
      confirmOk.className = `btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`;
      confirmOk.disabled = needType;
      const onType = () => {
        const okType = !needType || typeInput.value.trim().toLowerCase() === String(requireText).toLowerCase();
        confirmOk.disabled = !okType;
        if (errEl) {
          errEl.textContent = okType ? '' : `Ketik ${requireText} untuk mengaktifkan tombol Hapus.`;
          typeInput.setAttribute('aria-invalid', okType ? 'false' : 'true');
        }
      };
      if (needType && typeInput) {
        typeInput.oninput = onType;
        onType();
      }
      dlgConfirm.returnValue = '';
      dlgConfirm.addEventListener('close', () => {
        if (needType && typeInput) typeInput.oninput = null;
        resolve(dlgConfirm.returnValue === 'ok' ? { reason: reasonInput.value.trim() } : null);
      }, { once: true });
      dlgConfirm.showModal();
      if (needType && typeInput) typeInput.focus();
      else (reason ? reasonInput : confirmOk).focus();
    });
  }

  // ---------------------------------------------------------------------------
  // Error field (dipakai semua form)
  // ---------------------------------------------------------------------------
  const F = (id) => $(`#${id}`);

  function clearErr(id) {
    const err = F(`${id}-err`);
    if (err) err.textContent = '';
    const input = F(id);
    if (input && input.tagName !== 'DIV') {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
    F(`${id}-group`)?.removeAttribute('data-invalid');
  }

  function setErr(id, msg) {
    const err = F(`${id}-err`);
    if (err) err.textContent = msg;
    const input = F(id);
    if (input && input.tagName !== 'DIV') {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', `${id}-err`);
    }
    F(`${id}-group`)?.setAttribute('data-invalid', 'true');
  }

  function focusField(id) {
    const el = F(id) || F(`${id}-group`)?.querySelector('input');
    el?.focus();
    el?.scrollIntoView({ block: 'center' });
  }

  // ---------------------------------------------------------------------------
  // Pemilih PIC project
  // ---------------------------------------------------------------------------
  const tokensEl = $('#owner-tokens');
  const ownerSearch = $('#f-owner-search');
  const optionsEl = $('#owner-options');
  let picked = [];
  let activeOpt = -1;

  function renderTokens() {
    tokensEl.innerHTML = picked.map((id) => `
      <span class="token">
        <span class="avatar avatar--xs">${esc(initials(teamName(id)))}</span>
        <span class="token-name">${esc(teamName(id))}</span>
        <button type="button" class="token-x" data-remove="${esc(id)}" aria-label="Hapus ${esc(teamName(id))} dari PIC project">
          ${icon('x')}
        </button>
      </span>`).join('');
    ownerSearch.placeholder = picked.length ? 'Tambah PIC lain' : 'Ketik nama karyawan';
  }

  function closeOptions() {
    optionsEl.hidden = true;
    optionsEl.innerHTML = '';
    ownerSearch.setAttribute('aria-expanded', 'false');
    ownerSearch.removeAttribute('aria-activedescendant');
    activeOpt = -1;
  }

  function openOptions() {
    const q = ownerSearch.value.trim().toLowerCase();
    const list = activeTeam().filter((u) => !picked.includes(u.id)
      && (!q || u.name.toLowerCase().includes(q) || u.username.includes(q)));

    if (!list.length) {
      optionsEl.hidden = false;
      optionsEl.innerHTML = `<li class="picker-none" role="presentation">${
        q ? `Tidak ada karyawan bernama “${esc(ownerSearch.value.trim())}”.` : 'Semua karyawan sudah dipilih.'}</li>`;
      ownerSearch.setAttribute('aria-expanded', 'true');
      activeOpt = -1;
      return;
    }

    optionsEl.innerHTML = list.map((u, i) => `
      <li id="opt-${esc(u.id)}" class="picker-opt" role="option" aria-selected="false" data-add="${esc(u.id)}" data-i="${i}">
        <span class="avatar avatar--sm">${esc(initials(u.name))}</span>
        <span class="picker-opt-text">
          <span class="picker-opt-name">${esc(u.name)}${u.id === user.id ? ' <span class="muted">(Anda)</span>' : ''}</span>
          <span class="picker-opt-mail mono">${esc('@' + u.username)}</span>
        </span>
      </li>`).join('');
    optionsEl.hidden = false;
    ownerSearch.setAttribute('aria-expanded', 'true');
    activeOpt = -1;
    optionsEl.scrollIntoView({ block: 'nearest' });
  }

  function highlight(i) {
    const opts = [...optionsEl.querySelectorAll('.picker-opt')];
    if (!opts.length) return;
    activeOpt = (i + opts.length) % opts.length;
    opts.forEach((o, n) => {
      const on = n === activeOpt;
      o.classList.toggle('is-active', on);
      o.setAttribute('aria-selected', String(on));
      if (on) {
        ownerSearch.setAttribute('aria-activedescendant', o.id);
        o.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function addOwner(id) {
    if (!id || picked.includes(id) || !team.some((u) => u.id === id)) return;
    picked.push(id);
    ownerSearch.value = '';
    renderTokens();
    clearErr('f-owner');
    openOptions();
    ownerSearch.focus();
  }

  function removeOwner(id) {
    picked = picked.filter((x) => x !== id);
    renderTokens();
    if (!optionsEl.hidden) openOptions();
  }

  ownerSearch.addEventListener('input', openOptions);
  ownerSearch.addEventListener('focus', openOptions);

  ownerSearch.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (optionsEl.hidden) openOptions();
      highlight(e.key === 'ArrowDown' ? activeOpt + 1 : activeOpt - 1);
      return;
    }
    if (e.key === 'Enter') {
      const opts = [...optionsEl.querySelectorAll('.picker-opt')];
      if (!optionsEl.hidden && opts.length) {
        e.preventDefault();
        addOwner(opts[activeOpt >= 0 ? activeOpt : 0].dataset.add);
      }
      return;
    }
    if (e.key === 'Escape' && !optionsEl.hidden) {
      e.stopPropagation();
      closeOptions();
      return;
    }
    if (e.key === 'Backspace' && !ownerSearch.value && picked.length) {
      removeOwner(picked[picked.length - 1]);
    }
  });

  $('#owner-picker').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      removeOwner(rm.dataset.remove);
      ownerSearch.focus();
      return;
    }
    const add = e.target.closest('[data-add]');
    if (add) {
      addOwner(add.dataset.add);
      return;
    }
    if (!e.target.closest('input')) ownerSearch.focus();
  });

  document.addEventListener('pointerdown', (e) => {
    if (!optionsEl.hidden && !e.target.closest('#owner-picker')) closeOptions();
  });

  // ---------------------------------------------------------------------------
  // Isian nama perusahaan: saran dari client yang sudah tersimpan.
  // Memilih salah satu akan mengisi PIC, WhatsApp, dan email sekaligus.
  // ---------------------------------------------------------------------------
  const companyInput = $('#f-company');
  const companyOptions = $('#company-options');
  let companyActive = -1;

  function closeCompany() {
    companyOptions.hidden = true;
    companyOptions.innerHTML = '';
    companyInput.setAttribute('aria-expanded', 'false');
    companyInput.removeAttribute('aria-activedescendant');
    companyActive = -1;
  }

  function openCompany() {
    const q = normName(companyInput.value);
    const list = db.clients
      .filter((c) => !q || normName(c.name).includes(q))
      .sort((a, b) => projectsOfClient(b.id).length - projectsOfClient(a.id).length
        || a.name.localeCompare(b.name, 'id'))
      .slice(0, 6);
    if (!list.length) {
      closeCompany();
      return;
    }
    companyOptions.innerHTML = list.map((c, i) => `
      <li id="copt-${esc(c.id)}" class="picker-opt" role="option" aria-selected="false"
          data-client="${esc(c.id)}" data-i="${i}">
        <span class="avatar avatar--sm" aria-hidden="true">${icon('building')}</span>
        <span class="picker-opt-text">
          <span class="picker-opt-name">${esc(c.name)}</span>
          <span class="picker-opt-mail">${esc(c.pic || 'tanpa PIC')}${
      c.wa ? ` · ${esc(waPretty(c.wa))}` : ''} · ${projectsOfClient(c.id).length} project</span>
        </span>
      </li>`).join('');
    companyOptions.hidden = false;
    companyInput.setAttribute('aria-expanded', 'true');
    companyActive = -1;
    companyOptions.scrollIntoView({ block: 'nearest' });
  }

  function highlightCompany(i) {
    const opts = [...companyOptions.querySelectorAll('.picker-opt')];
    if (!opts.length) return;
    companyActive = (i + opts.length) % opts.length;
    opts.forEach((o, n) => {
      const on = n === companyActive;
      o.classList.toggle('is-active', on);
      o.setAttribute('aria-selected', String(on));
      if (on) {
        companyInput.setAttribute('aria-activedescendant', o.id);
        o.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  // Mengisi seluruh kontak dari client yang dipilih.
  function pickClient(id) {
    const c = clientById(id);
    if (!c) return;
    companyInput.value = c.name;
    F('f-pic').value = c.pic || '';
    F('f-wa').value = groupWa(waLocal(c.wa));
    F('f-email').value = c.email || '';
    formEl.dataset.clientId = c.id;
    closeCompany();
    ['f-company', 'f-pic', 'f-wa', 'f-email'].forEach(clearErr);
    const n = projectsOfClient(c.id).length;
    $('#f-company-hint').innerHTML = `Kontak terisi dari client tersimpan. Client ini sudah punya <b>${n} project</b>.`;
    F('f-pic').focus();
  }

  companyInput.addEventListener('input', () => {
    // Nama diubah manual, jadi tautan ke client lama dilepas.
    const picked2 = formEl.dataset.clientId ? clientById(formEl.dataset.clientId) : null;
    if (picked2 && normName(picked2.name) !== normName(companyInput.value)) {
      formEl.dataset.clientId = '';
      $('#f-company-hint').textContent = 'Pilih client yang sudah tersimpan untuk mengisi kontaknya otomatis.';
    }
    openCompany();
  });
  companyInput.addEventListener('focus', openCompany);

  companyInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (companyOptions.hidden) openCompany();
      highlightCompany(e.key === 'ArrowDown' ? companyActive + 1 : companyActive - 1);
      return;
    }
    if (e.key === 'Enter' && !companyOptions.hidden && companyActive >= 0) {
      e.preventDefault();
      pickClient(companyOptions.querySelectorAll('.picker-opt')[companyActive].dataset.client);
      return;
    }
    if (e.key === 'Escape' && !companyOptions.hidden) {
      e.stopPropagation();
      closeCompany();
    }
  });

  $('#company-combo').addEventListener('click', (e) => {
    const opt = e.target.closest('[data-client]');
    if (opt) pickClient(opt.dataset.client);
  });

  document.addEventListener('pointerdown', (e) => {
    if (!companyOptions.hidden && !e.target.closest('#company-combo')) closeCompany();
  });

  // ---------------------------------------------------------------------------
  // Dialog client
  // ---------------------------------------------------------------------------
  const dlgClient = $('#dlg-client');
  const clientFormEl = $('#client-form');
  const CLIENT_ERRS = ['c-name', 'c-wa', 'c-email'];

  F('c-wa').addEventListener('input', () => {
    const el = F('c-wa');
    let d = digitsOnly(el.value);
    if (d.startsWith('62')) d = d.slice(2);
    el.value = groupWa(d.replace(/^0+/, '').slice(0, 13));
    clearErr('c-wa');
  });
  ['c-name', 'c-email'].forEach((id) => F(id).addEventListener('input', () => clearErr(id)));

  function openClientForm(id = null) {
    const c = id ? clientById(id) : null;
    clientFormEl.reset();
    CLIENT_ERRS.forEach(clearErr);
    clientFormEl.dataset.id = c ? c.id : '';
    const allowed = can('editClient');

    $('#client-title').textContent = c ? c.name : 'Client baru';
    $('#client-sub').textContent = c
      ? (allowed ? 'Perubahan di sini langsung berlaku di semua project client ini.' : 'Hanya bisa dilihat dengan role Anda.')
      : 'Client baru bisa langsung dipilih saat input project.';
    $('#client-submit').hidden = !allowed;
    $('#client-note').textContent = c && c.createdAt
      ? `Tersimpan sejak ${dFull.format(new Date(c.createdAt))}`
      : '';

    if (c) {
      F('c-name').value = c.name;
      F('c-pic').value = c.pic || '';
      F('c-wa').value = groupWa(waLocal(c.wa));
      F('c-email').value = c.email || '';
      F('c-notes').value = c.notes || '';
    }
    [...clientFormEl.querySelectorAll('input, textarea')].forEach((el) => { el.disabled = !allowed; });

    // Daftar project milik client ini, supaya riwayatnya kelihatan.
    const mine = c ? projectsOfClient(c.id).slice().sort((a, b) => (a.stageChangedAt < b.stageChangedAt ? 1 : -1)) : [];
    $('#client-projects').innerHTML = c ? `
      <h3>Project client ini <span class="muted">(${mine.length})</span></h3>
      ${mine.length ? `<ul class="client-proj">${mine.map((p) => `
        <li>
          <span class="mono client-proj-no">${esc(p.qlNo || p.id)}</span>
          <span class="client-proj-text">
            <span class="t-name">${esc(p.name)}</span>
            <span class="t-sub">${esc(typeLabel(p))}</span>
          </span>
          <span class="badge badge--${p.stage}">${STAGES[p.stage].label}</span>
          <span class="mono client-proj-val">${p.stage === 'deal' ? esc(rpShort(dealOf(p))) : p.offer ? esc(rpShort(p.offer)) : '—'}</span>
        </li>`).join('')}</ul>`
    : '<p class="muted">Belum ada project untuk client ini.</p>'}` : '';

    dlgClient.showModal();
    if (allowed) F('c-name').focus();
  }

  clientFormEl.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!can('editClient')) {
      dlgClient.close();
      return;
    }
    const id = clientFormEl.dataset.id;
    const name = F('c-name').value.trim();
    const waRaw = digitsOnly(F('c-wa').value);
    const email = F('c-email').value.trim();

    CLIENT_ERRS.forEach(clearErr);
    const errs = [];
    if (!name) errs.push(['c-name', 'Nama perusahaan wajib diisi.']);
    else {
      const twin = clientByName(name);
      if (twin && twin.id !== id) errs.push(['c-name', 'Nama perusahaan ini sudah ada di daftar client.']);
    }
    if (waRaw && waRaw.length < 10) errs.push(['c-wa', 'Nomor terlalu pendek. Contoh: 812 3456 7890.']);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.push(['c-email', 'Format email belum benar.']);
    if (errs.length) {
      errs.forEach(([f, m]) => setErr(f, m));
      focusField(errs[0][0]);
      return;
    }

    const data = {
      name, pic: F('c-pic').value.trim(), wa: waRaw ? `62${waRaw}` : '', email, notes: F('c-notes').value.trim(),
    };
    if (id) {
      Object.assign(clientById(id), data);
    } else {
      db.clients.push({ ...data, id: newClientId(), createdAt: new Date().toISOString(), createdBy: user.id });
    }
    save();
    dlgClient.close();
    render();
    toast(`Client ${name} disimpan.`, { tone: 'ok' });
  });

  async function deleteClient(id) {
    const c = clientById(id);
    if (!c) return;
    const n = projectsOfClient(id).length;
    if (n) {
      toast(`${c.name} masih dipakai ${n} project, jadi tidak bisa dihapus.`, { tone: 'warn' });
      return;
    }
    const ok = await confirmDialog({
      title: `Hapus client ${c.name}?`,
      body: 'Client ini belum dipakai project mana pun.',
      okLabel: 'Hapus client',
      tone: 'danger',
    });
    if (!ok) return;
    db.clients = db.clients.filter((x) => x.id !== id);
    save();
    render();
    toast(`Client ${c.name} dihapus.`);
  }

  // ---------------------------------------------------------------------------
  // Form project
  // ---------------------------------------------------------------------------
  const PROJECT_ERRS = ['f-name', 'f-ent', 'f-type', 'f-subtype', 'f-start', 'f-end', 'f-lead', 'f-source',
    'f-company', 'f-pic', 'f-wa', 'f-email', 'f-owner'];

  const radioValue = (name) => {
    const el = formEl.querySelector(`input[name="${name}"]:checked`);
    return el ? el.value : '';
  };

  function showTypeHint() {
    const t = radioValue('ptype');
    $('#f-type-hint').innerHTML = t
      ? `Nomor QL nanti memakai awalan <b class="mono">${qlPrefix(t)}</b>, mis. <span class="mono">${esc(peekQlNo(t))}</span>.${
        rabRequired(t) ? ' Quotation dan RAB <b>wajib</b> diunggah saat project jadi Deal.' : ' Quotation <b>wajib</b> diunggah saat project jadi Deal.'}`
      : 'Awalan nomor QL mengikuti tipe project.';
  }

  // Kategori dibangun ulang setiap tipe berubah, karena daftarnya beda per tipe.
  function renderSubtypes(selected = '', otherText = '') {
    const type = radioValue('ptype');
    const list = subtypesOf(type);
    const wrap = $('#f-subtype-wrap');
    wrap.hidden = list.length === 0;
    if (!list.length) {
      $('#f-subtype-group').innerHTML = '';
      $('#f-subtype-other-wrap').hidden = true;
      $('#f-subtype-other').value = '';
      return;
    }
    const known = list.includes(selected);
    const pickOther = Boolean(selected) && !known;
    $('#f-subtype-group').innerHTML = list.map((s) => `
      <label class="chip">
        <input type="radio" name="psub" value="${esc(s)}" ${
      (known && s === selected) || (pickOther && s === OTHER) ? 'checked' : ''}>
        <span>${esc(s)}</span>
      </label>`).join('');
    $('#f-subtype-other').value = pickOther ? selected : otherText;
    syncOther();
  }

  // Teks bebas hanya tampil saat "Lainnya" dipilih.
  function syncOther() {
    const other = radioValue('psub') === OTHER;
    $('#f-subtype-other-wrap').hidden = !other;
    if (!other) $('#f-subtype-other').value = '';
  }

  function subtypeValue() {
    const sel = radioValue('psub');
    if (!sel) return '';
    return sel === OTHER ? $('#f-subtype-other').value.trim() : sel;
  }

  function openForm(id = null) {
    const p = id ? find(id) : null;
    formEl.reset();
    PROJECT_ERRS.forEach(clearErr);
    closeOptions();
    formEl.dataset.editing = p ? p.id : '';
    formEl.dataset.clientId = '';
    closeCompany();
    $('#f-company-hint').textContent = 'Pilih client yang sudah tersimpan untuk mengisi kontaknya otomatis.';

    $('#form-title').textContent = p ? `Edit ${p.qlNo || p.id}` : 'Project baru';
    $('#form-sub').innerHTML = p
      ? `Tahap saat ini <b>${STAGES[p.stage].label}</b>. Mengubah data tidak mengubah tahap atau nomor QL.`
      : 'Setelah disimpan, project otomatis masuk ke <b>Lead Masuk</b>.';
    $('#form-submit').textContent = p ? 'Simpan perubahan' : 'Simpan ke Lead Masuk';
    $('#form-foot-note').textContent = p ? '' : 'Tahap awal: Lead Masuk';

    if (p) {
      F('f-name').value = p.name || '';
      formEl.querySelectorAll('input[name="pent"]').forEach((r) => { r.checked = r.value === p.entity; });
      formEl.querySelectorAll('input[name="ptype"]').forEach((r) => { r.checked = r.value === p.type; });
      F('f-start').value = p.start || '';
      F('f-end').value = p.end || '';
      formEl.querySelectorAll('input[name="lead"]').forEach((r) => { r.checked = r.value === p.lead; });
      F('f-source').value = p.source || '';
      const c = clientOf(p);
      F('f-company').value = c.id ? c.name : '';
      F('f-pic').value = c.pic || '';
      F('f-wa').value = groupWa(waLocal(c.wa));
      F('f-email').value = c.email || '';
      formEl.dataset.clientId = c.id || '';
      F('f-desc').value = p.desc || '';
      picked = (p.owners || []).filter((o) => team.some((u) => u.id === o));
    } else {
      picked = [user.id]; // default: pembuat project jadi PIC
    }
    // Tipe project tidak boleh diubah setelah nomor QL terbit.
    const lockType = p && hasQl(p);
    formEl.querySelectorAll('input[name="ptype"]').forEach((r) => { r.disabled = lockType; });
    $('#f-type-group').classList.toggle('is-locked', Boolean(lockType));
    showTypeHint();
    renderSubtypes(p ? p.subtype || '' : '');
    if (lockType) {
      $('#f-type-hint').innerHTML = `Tipe project terkunci karena nomor QL <span class="mono">${esc(p.qlNo)}</span> sudah terbit. Kategori masih bisa diubah.`;
    }
    renderTokens();
    dlgForm.showModal();
    F('f-name').focus();
  }

  F('f-start').addEventListener('change', () => {
    const s = F('f-start').value;
    F('f-end').min = s;
    if (s && (!F('f-end').value || F('f-end').value < s)) F('f-end').value = s;
    clearErr('f-start');
    clearErr('f-end');
  });
  $('#same-day').addEventListener('click', () => {
    F('f-end').value = F('f-start').value;
    clearErr('f-end');
  });

  // Format nomor sambil menjaga posisi kursor agar bisa menyunting di tengah.
  F('f-wa').addEventListener('input', () => {
    const el = F('f-wa');
    const before = el.value.slice(0, el.selectionStart ?? el.value.length);
    const digitsBefore = digitsOnly(before).length;
    let d = digitsOnly(el.value);
    if (d.startsWith('62')) d = d.slice(2);
    d = d.replace(/^0+/, '').slice(0, 13);
    el.value = groupWa(d);
    let pos = 0;
    let seen = 0;
    while (pos < el.value.length && seen < digitsBefore) {
      if (/\d/.test(el.value[pos])) seen += 1;
      pos += 1;
    }
    el.setSelectionRange(pos, pos);
  });

  ['f-name', 'f-start', 'f-end', 'f-source', 'f-company', 'f-pic', 'f-wa', 'f-email']
    .forEach((id) => F(id).addEventListener('input', () => clearErr(id)));
  $('#f-ent-group').addEventListener('change', () => clearErr('f-ent'));
  $('#f-type-group').addEventListener('change', () => {
    clearErr('f-type');
    clearErr('f-subtype');
    showTypeHint();
    renderSubtypes();
  });
  $('#f-subtype-group').addEventListener('change', () => {
    clearErr('f-subtype');
    syncOther();
    if (radioValue('psub') === OTHER) $('#f-subtype-other').focus();
  });
  $('#f-subtype-other').addEventListener('input', () => clearErr('f-subtype'));
  $('#f-lead-group').addEventListener('change', () => clearErr('f-lead'));

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const editing = formEl.dataset.editing;
    const current = editing ? find(editing) : null;
    const waRaw = digitsOnly(F('f-wa').value);
    const clientInput = {
      name: F('f-company').value.trim(),
      pic: F('f-pic').value.trim(),
      wa: waRaw ? `62${waRaw}` : '',
      email: F('f-email').value.trim(),
    };
    const data = {
      name: F('f-name').value.trim(),
      entity: radioValue('pent'),
      // Tipe terkunci saat QL sudah terbit: radio disabled, jadi pakai nilai lama.
      type: (current && hasQl(current)) ? current.type : radioValue('ptype'),
      subtype: subtypeValue(),
      start: F('f-start').value,
      end: F('f-end').value,
      lead: radioValue('lead'),
      source: F('f-source').value,
      desc: F('f-desc').value.trim(),
      owners: [...picked],
    };

    PROJECT_ERRS.forEach(clearErr);
    const errs = [];
    if (!data.name) errs.push(['f-name', 'Nama project wajib diisi.']);
    if (!data.entity) errs.push(['f-ent', 'Pilih entitas perusahaan.']);
    if (!data.type) errs.push(['f-type', 'Pilih salah satu tipe project.']);
    else if (subtypesOf(data.type).length && !radioValue('psub')) {
      errs.push(['f-subtype', 'Pilih salah satu kategori.']);
    } else if (radioValue('psub') === OTHER && !data.subtype) {
      errs.push(['f-subtype', 'Tulis kategori lainnya.']);
    }
    // Tanggal kegiatan opsional. Bila keduanya diisi, urutannya harus benar.
    if (data.start && data.end && data.end < data.start) {
      errs.push(['f-end', 'Tanggal akhir tidak boleh sebelum tanggal mulai.']);
    }
    if (!data.lead) errs.push(['f-lead', 'Pilih jenis lead: Cold atau Hot.']);
    if (!data.source) errs.push(['f-source', 'Pilih sumber lead.']);
    if (!clientInput.name) errs.push(['f-company', 'Nama perusahaan wajib diisi.']);
    if (!clientInput.pic) errs.push(['f-pic', 'Nama PIC client wajib diisi.']);
    if (!waRaw) errs.push(['f-wa', 'No WhatsApp wajib diisi.']);
    else if (waRaw.length < 10) errs.push(['f-wa', 'Nomor terlalu pendek. Contoh: 812 3456 7890.']);
    if (clientInput.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientInput.email)) errs.push(['f-email', 'Format email belum benar.']);
    if (!data.owners.length) errs.push(['f-owner', 'Pilih minimal satu PIC project.']);

    if (errs.length) {
      errs.forEach(([f, m]) => setErr(f, m));
      focusField(errs[0][0]);
      toast(`${errs.length} data masih perlu diperbaiki.`, { tone: 'warn', duration: 4000 });
      return;
    }

    // Satu tempat untuk data client: dipakai ulang bila namanya sudah ada.
    const client = upsertClient(clientInput);
    data.clientId = client.id;

    if (editing) {
      dlgForm.close();
      if (!current) return;
      const before = JSON.stringify(current);
      Object.assign(current, data);
      audit(current.id, 'project.update', 'edit data project');
      save();
      render();
      toast(`Perubahan ${current.qlNo || current.id} disimpan.`, { tone: 'ok' });
      return;
    }

    const at = new Date().toISOString();
    const p = {
      id: nextId(), ...data, stage: 'lead',
      qlNo: '', qlStatus: '', qlNote: '', qlAt: '', offer: 0,
      createdAt: at, createdBy: user.id, stageChangedAt: at,
      history: [{ stage: 'lead', at, by: user.id }],
    };
    db.projects.push(p);
    audit(p.id, 'project.create', p.name);
    save();
    dlgForm.close();
    if (ui.query) {
      ui.query = '';
      searchEl.value = '';
    }
    if (ui.page !== 'project' || (ui.tab !== 'all' && ui.tab !== 'lead')) setTab('lead');
    else render();
    flash(p.id);
    const repeat = projectsOfClient(client.id).length;
    toast(`${p.id} masuk ke Lead Masuk.${repeat > 1 ? ` Project ke-${repeat} untuk ${client.name}.` : ''}`, {
      tone: 'ok',
      action: { label: 'Lihat detail', run: () => openDetail(p.id) },
    });
  });

  async function deleteProject(id) {
    const p = find(id);
    if (!p) return;
    const ok = await confirmDialog({
      title: `Hapus ${p.qlNo || p.id}?`,
      body: 'Kamu yakin akan menghapus ini? Data dan dokumennya akan ikut terhapus. Tindakan ini tidak bisa dibatalkan.',
      okLabel: 'Hapus',
      tone: 'danger',
      requireText: 'yakin',
    });
    if (!ok) return;
    const fileIds = Object.values(p.docs || {}).map((m) => m && m.id).filter(Boolean);
    if (fileIds.length) AlurStore.deleteFiles(fileIds);
    db.audit = db.audit.filter((a) => a.projectId !== id);
    db.projects = db.projects.filter((x) => x.id !== id);
    save();
    if (ui.detailId === id && dlgDetail.open) dlgDetail.close();
    render();
    toast(`${p.qlNo || id} dihapus permanen.`);
  }

  // Hapus banyak project sekaligus (Manager/Admin) = permanen langsung.
  async function deleteSelected() {
    const ids = [...ui.selected].filter((id) => find(id));
    if (!ids.length) { ui.selected.clear(); renderView(); return; }
    const names = ids.slice(0, 8).map((id) => {
      const p = find(id);
      return `“${p.name}” (${p.qlNo || p.id})`;
    }).join(', ');
    const more = ids.length > 8 ? `, dan ${ids.length - 8} project lain` : '';
    const ok = await confirmDialog({
      title: `Hapus ${ids.length} project permanen?`,
      body: `${names}${more}. Kamu yakin akan menghapus ini? Data dan dokumennya akan ikut terhapus.`,
      okLabel: `Hapus`,
      tone: 'danger',
      requireText: 'yakin',
    });
    if (!ok) return;
    const fileIds = ids.flatMap((id) => Object.values(find(id).docs || {})
      .map((m) => m && m.id).filter(Boolean));
    if (fileIds.length) AlurStore.deleteFiles(fileIds);
    const idSet = new Set(ids);
    db.projects = db.projects.filter((x) => !idSet.has(x.id));
    db.audit = db.audit.filter((a) => !idSet.has(a.projectId));
    if (ui.detailId && idSet.has(ui.detailId) && dlgDetail.open) dlgDetail.close();
    ui.selected.clear();
    save();
    render();
    toast(`${ids.length} project dihapus permanen.`);
  }
  // ---------------------------------------------------------------------------
  // Akun karyawan
  // ---------------------------------------------------------------------------
  const USER_ERRS = ['u-name', 'u-username', 'u-role', 'u-password', 'u-old-password'];

  function openUserForm(id = null) {
    const target = id ? team.find((u) => u.id === id) : null;
    const isMe = target && target.id === user.id;
    // Semua orang boleh mengubah akunnya sendiri; akun orang lain hanya admin.
    if (!isMe && !can('manageUsers')) {
      toast(denyReason('manageUsers'), { tone: 'warn' });
      return;
    }
    userFormEl.reset();
    USER_ERRS.forEach(clearErr);
    userFormEl.dataset.editing = target ? target.id : '';

    const canRole = can('manageUsers');
    $('#user-title').textContent = target ? (isMe ? 'Akun saya' : `Edit akun ${target.name}`) : 'Buat akun karyawan';
    $('#user-sub').textContent = target
      ? 'Nama baru langsung dipakai di seluruh daftar PIC project.'
      : 'Karyawan baru langsung muncul sebagai pilihan PIC project dan bisa dipakai untuk masuk.';
    $('#user-submit').textContent = target ? 'Simpan perubahan' : 'Buat akun';
    $('#u-password-opt').hidden = !target;
    F('u-password').required = !target;
    F('u-password').placeholder = target ? 'Biarkan kosong bila tidak diubah' : 'Minimal 6 karakter';
    const showOld = Boolean(isMe && target);
    const oldWrap = $('#u-old-wrap');
    if (oldWrap) oldWrap.hidden = !showOld;
    if (showOld) F('u-old-password').value = '';

    // Role hanya bisa diatur admin. Role sendiri tidak bisa diubah sendiri.
    const showRole = canRole && !isMe;
    $('#u-role-wrap').hidden = !showRole;
    $('#u-role-group').innerHTML = AlurStore.ROLES.map((r) => `
      <label class="pick-opt">
        <input type="radio" name="urole" value="${r.id}" ${
      (target ? target.role : 'user') === r.id ? 'checked' : ''}>
        <span class="pick-body">
          <span class="pick-title">${esc(r.label)}</span>
          <span class="pick-desc">${esc(r.desc)}</span>
        </span>
      </label>`).join('');

    if (target) {
      F('u-name').value = target.name;
      F('u-username').value = target.username;
    }
    dlgUser.showModal();
    F('u-name').focus();
  }

  // u-role adalah radiogroup, bukan input tunggal, jadi ditangani terpisah.
  ['u-name', 'u-username', 'u-password', 'u-old-password'].forEach((id) => { const el = F(id); if (el) el.addEventListener('input', () => clearErr(id)); });
  $('#u-role-group').addEventListener('change', () => clearErr('u-role'));

  function openBulkUser() {
    if (!can('manageUsers')) { toast(denyReason('manageUsers'), { tone: 'warn' }); return; }
    bulkUserForm.reset();
    const err = $('#b-users-err'); if (err) err.textContent = '';
    const res = $('#b-result'); if (res) res.innerHTML = '';
    dlgBulkUser.showModal();
    F('b-users').focus();
  }

  bulkUserForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = F('b-users').value;
    const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { setErr('b-users', 'Isi minimal satu baris.'); return; }
    clearErr('b-users');
    const submitBtn = $('#b-submit');
    submitBtn.disabled = true;
    const results = [];
    for (const line of lines) {
      const parts = line.split(',').map((s) => s.trim());
      const [name, usernameRaw, password, roleRaw] = parts;
      const role = (roleRaw || 'user').toLowerCase();
      const check = (msg) => results.push({ ok: false, line, msg });
      if (!name || name.length < 2) { check(`Nama "${name || '—'}" tidak valid.`); continue; }
      if (!usernameRaw || !/^[a-z0-9._-]{3,40}$/.test(usernameRaw.toLowerCase())) { check(`Username "${usernameRaw || '—'}" tidak valid.`); continue; }
      if (!password || password.length < 6) { check(`Password untuk "${usernameRaw}" minimal 6 karakter.`); continue; }
      if (!['user', 'finance', 'manager', 'admin'].includes(role)) { check(`Role "${roleRaw}" tidak dikenal.`); continue; }
      try {
        await AlurStore.register({ name, username: usernameRaw.toLowerCase(), password, role });
        results.push({ ok: true, line: `${name} (@${usernameRaw.toLowerCase()})` });
      } catch (err) {
        results.push({ ok: false, line, msg: err.message || 'Gagal.' });
      }
    }
    team = AlurStore.publicUsers();
    const okCount = results.filter((r) => r.ok).length;
    const res = $('#b-result');
    if (res) {
      res.innerHTML = `<p class="notes">${okCount}/${results.length} akun dibuat.</p>`
        + `<ul class="role-help" style="margin-top:8px">${results.map((r) => `<li><span>${r.ok ? '✓' : '✗'}</span><span>${esc(r.ok ? r.line : `${r.line} — ${r.msg}`)}</span></li>`).join('')}</ul>`;
    }
    submitBtn.disabled = false;
    if (okCount) { audit('', 'user.bulk-create', `${okCount} akun`); save(); render(); }
    toast(`${okCount}/${results.length} akun dibuat.`, { tone: okCount ? 'ok' : 'warn' });
  });

  userFormEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const editing = userFormEl.dataset.editing;
    const name = F('u-name').value.trim();
    const username = F('u-username').value.trim().toLowerCase();
    const password = F('u-password').value;
    const roleEl = userFormEl.querySelector('input[name="urole"]:checked');
    const role = $('#u-role-wrap').hidden ? undefined : (roleEl || {}).value;

    USER_ERRS.forEach(clearErr);
    const errs = [];
    if (name.length < 2) errs.push(['u-name', 'Nama lengkap wajib diisi.']);
    if (!username) errs.push(['u-username', 'Username wajib diisi.']);
    else if (!/^[a-z0-9._-]{3,40}$/.test(username)) errs.push(['u-username', 'Username 3-40 karakter: huruf kecil, angka, titik, garis bawah, atau strip.']);
    if (!$('#u-role-wrap').hidden && !role) errs.push(['u-role', 'Pilih role karyawan.']);
    if (!editing && !password) errs.push(['u-password', 'Password wajib diisi.']);
    else if (password && password.length < 6) errs.push(['u-password', 'Password minimal 6 karakter.']);
    if (editing === user.id && password) {
      const oldPw = F('u-old-password') ? F('u-old-password').value : '';
      if (!oldPw) errs.push(['u-old-password', 'Isi password saat ini untuk ganti password.']);
      else if (!(await AlurStore.verifyPassword(user.id, oldPw))) errs.push(['u-old-password', 'Password saat ini salah.']);
    }
    if (errs.length) {
      errs.forEach(([f, m]) => setErr(f, m));
      focusField(errs[0][0]);
      return;
    }

    const submit = $('#user-submit');
    submit.disabled = true;
    try {
      if (editing) {
        const saved = await AlurStore.updateUser(editing, { name, username, password, role });
        team = AlurStore.publicUsers();
        if (editing === user.id) user = saved;
        audit(editing, 'user.update', saved.name);
        save();
        dlgUser.close();
        render();
        toast(`Akun ${saved.name} diperbarui.`, { tone: 'ok' });
      } else {
        const created = await AlurStore.register({ name, username, password, role });
        team = AlurStore.publicUsers();
        dlgUser.close();
        render();
        toast(`Akun ${created.name} dibuat sebagai ${ROLE_LABEL[created.role]}. Bisa masuk dengan username ${created.username}.`, { tone: 'ok' });
      }
    } catch (err) {
      const field = /role|admin terakhir/i.test(err.message) ? 'u-role' : 'u-username';
      setErr(field, err.message || 'Gagal menyimpan akun.');
      focusField(field);
    } finally {
      submit.disabled = false;
    }
  });

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------
  let toastTimer = 0;

  function toast(message, { tone = 'info', action = null, duration = 6000 } = {}) {
    // Saat dialog modal terbuka, elemen di luarnya tidak bisa diklik.
    // Pindahkan toast ke dalam dialog teratas agar tombolnya tetap berfungsi.
    const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
    if (toastRegion.parentElement !== host) host.appendChild(toastRegion);
    clearTimeout(toastTimer);
    const ic = tone === 'warn' ? icon('alert') : tone === 'ok' ? icon('check') : '';
    toastRegion.innerHTML = `<div class="toast toast--${tone}">${ic}<span>${esc(message)}</span>${
      action ? `<button type="button" class="toast-action">${action.icon ? icon(action.icon) : ''}${esc(action.label)}</button>` : ''
    }<button type="button" class="toast-close" aria-label="Tutup notifikasi">${icon('x')}</button></div>`;
    const el = toastRegion.firstElementChild;
    if (action) {
      el.querySelector('.toast-action').addEventListener('click', () => {
        hideToast();
        action.run();
      });
    }
    el.querySelector('.toast-close').addEventListener('click', hideToast);
    el.addEventListener('pointerenter', () => clearTimeout(toastTimer));
    el.addEventListener('pointerleave', () => { toastTimer = setTimeout(hideToast, 2500); });
    toastTimer = setTimeout(hideToast, duration);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastRegion.innerHTML = '';
  }

  // ---------------------------------------------------------------------------
  // Sidebar
  // ---------------------------------------------------------------------------
  const MOBILE = () => window.matchMedia('(max-width: 1023px)').matches;
  const openBtn = $('#sidebar-open');

  function setSidebar(open) {
    ui.sidebar = open;
    document.body.classList.toggle('side-open', open);
    openBtn.setAttribute('aria-expanded', String(open));
    scrimEl.hidden = !(open && MOBILE());
    if (open && MOBILE()) $('#sidebar-close').focus();
  }

  openBtn.addEventListener('click', () => setSidebar(!ui.sidebar));
  $('#sidebar-close').addEventListener('click', () => {
    setSidebar(false);
    openBtn.focus();
  });
  scrimEl.addEventListener('click', () => setSidebar(false));

  // Di layar lebar sidebar terbuka secara bawaan; di layar kecil tertutup.
  setSidebar(!MOBILE());
  window.matchMedia('(max-width: 1023px)').addEventListener('change', (e) => setSidebar(!e.matches));

  async function logout() {
    const ok = await confirmDialog({
      title: 'Keluar dari akun?',
      body: `Anda akan keluar sebagai ${user.name}. Data project tetap tersimpan di browser ini.`,
      okLabel: 'Keluar',
      tone: 'danger',
    });
    if (!ok) return;
    AlurStore.clearSession();
    location.replace('login.html');
  }

  // ---------------------------------------------------------------------------
  // Navigasi: halaman (Pipeline Project / Karyawan) dan tab tahap
  // ---------------------------------------------------------------------------
  function routeFromHash() {
    const slug = location.hash.replace(/^#\/?/, '');
    if (slug === 'karyawan') return { page: 'staff', tab: 'all' };
    if (slug === 'clients') return { page: 'clients', tab: 'all' };
    if (slug === 'laporan') return { page: 'report', tab: 'all' };
    if (slug === 'master-data') return { page: 'master', tab: 'all' };
    if (!slug || slug === 'semua' || slug === 'sampah') return { page: 'project', tab: 'all' };
    return { page: 'project', tab: ORDER.find((k) => STAGES[k].slug === slug) || 'all' };
  }

  const PAGE_SLUG = { clients: '#/clients', report: '#/laporan', staff: '#/karyawan', master: '#/master-data' };

  // Pencarian dipakai bersama; kosongkan saat pindah halaman agar tidak terbawa.
  function resetSearch() {
    ui.query = '';
    searchEl.value = '';
  }

  function setTab(k) {
    if (ui.page !== 'project') resetSearch();
    if (ui.tab !== k) ui.list.page = 1;
    ui.page = 'project';
    ui.tab = TABS.includes(k) ? k : 'all';
    const slug = ui.tab === 'all' ? 'semua' : STAGES[ui.tab].slug;
    history.replaceState(null, '', `#/${slug}`);
    render();
  }

  function setPage(page) {
    if (page === 'project') {
      setTab(ui.tab);
    } else {
      if (ui.page !== page) resetSearch();
      ui.page = page;
      history.replaceState(null, '', PAGE_SLUG[page]);
      render();
    }
    if (MOBILE()) setSidebar(false);
    viewEl.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  window.addEventListener('hashchange', () => {
    const r = routeFromHash();
    if (r.page !== ui.page) resetSearch();
    ui.page = r.page;
    ui.tab = r.tab;
    render();
  });

  railEl.addEventListener('keydown', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (!tab) return;
    const i = TABS.indexOf(tab.dataset.tab);
    const map = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 };
    if (!(e.key in map)) return;
    e.preventDefault();
    const next = TABS[(map[e.key] + TABS.length) % TABS.length];
    setTab(next);
    $(`#tab-${next}`).focus();
  });

  // ---------------------------------------------------------------------------
  // Event global
  // ---------------------------------------------------------------------------
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (e.target.matches('[data-select], [data-select-all]')) return;

    const closeBtn = t.closest('[data-close]');
    if (closeBtn) {
      closeBtn.closest('dialog')?.close();
      return;
    }
    const pageLink = t.closest('[data-page]');
    if (pageLink) {
      e.preventDefault();
      setPage(pageLink.dataset.page);
      return;
    }
    const tab = t.closest('[data-tab]');
    if (tab) {
      setTab(tab.dataset.tab);
      return;
    }
    // Tab di dalam halaman Laporan
    const rtab = t.closest('[data-rtab]');
    if (rtab) {
      ui.report.tab = rtab.dataset.rtab;
      renderView();
      $(`[data-rtab="${ui.report.tab}"]`)?.focus();
      return;
    }
    // Preset rentang tanggal laporan
    const range = t.closest('[data-range]');
    if (range) {
      const now = new Date();
      const back = (days) => {
        const d = new Date(now.getTime() - days * DAY);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      const r = range.dataset.range;
      if (r === 'all') ui.report = { ...ui.report, from: '', to: '' };
      else if (r === 'year') ui.report = { ...ui.report, from: `${now.getFullYear()}-01-01`, to: todayISO() };
      else ui.report = { ...ui.report, from: back(Number(r)), to: todayISO() };
      renderView();
      return;
    }
    const pgBtn = t.closest('[data-page-nav]');
    if (pgBtn && !pgBtn.disabled) {
      const [scope, val] = pgBtn.dataset.pageNav.split(':');
      const st = scope === 'client' ? ui.clientList : ui.list;
      if (val === 'prev') st.page = Math.max(1, st.page - 1);
      else if (val === 'next') st.page += 1;
      else st.page = Number(val) || 1;
      renderView();
      window.scrollTo({ top: 0 });
      return;
    }
    const mv = t.closest('[data-move]');
    if (mv) {
      e.stopPropagation();
      requestMove(mv.dataset.id, mv.dataset.move);
      return;
    }
    const act = t.closest('[data-action]');
    if (act) {
      e.preventDefault();
      e.stopPropagation();
      const a = act.dataset.action;
      if (a === 'new') openGuarded('createProject', () => openForm());
      else if (a === 'edit') openGuarded('editProject', () => openForm(act.dataset.id), find(act.dataset.id));
      else if (a === 'edit-ql') openGuarded('editQl', () => openQlForm(act.dataset.id, true), find(act.dataset.id));
      else if (a === 'edit-deal') openGuarded('editDocs', () => openDealForm(act.dataset.id, true), find(act.dataset.id));
      else if (a === 'delete') openGuarded('deleteProject', () => deleteProject(act.dataset.id), find(act.dataset.id));
      else if (a === 'delete-selected') openGuarded('deleteProject', () => deleteSelected());
      else if (a === 'clear-selection') { ui.selected.clear(); renderView(); }
      else if (a === 'master-add-type') masterAddRow('type');
      else if (a === 'master-add-ent') masterAddRow('ent');
      else if (a === 'master-del-type') act.closest('[data-type-i]')?.remove();
      else if (a === 'master-del-ent') act.closest('[data-ent-i]')?.remove();
      else if (a === 'master-reset') {
        if (!can('masterData')) { toast(denyReason('masterData'), { tone: 'warn' }); }
        else {
          const ok = await confirmDialog({ title: 'Reset Master Data ke default?', body: 'Tipe/kategori/entitas/sumber kembali ke bawaan. Riwayat versi tetap disimpan.', okLabel: 'Reset', tone: 'danger' });
          if (ok) { resetMaster(); render(); toast('Master data direset ke default.', { tone: 'ok' }); }
        }
      }
      else if (a === 'new-user') openUserForm();
      else if (a === 'new-bulk-user') openBulkUser();
      else if (a === 'edit-user') openUserForm(act.dataset.id);
      else if (a === 'edit-me') openUserForm(user.id);
      else if (a === 'deactivate-user') {
        const targetId = act.dataset.id;
        const target = team.find((u) => u.id === targetId);
        if (!can('manageUsers') || targetId === user.id) { toast(denyReason('manageUsers'), { tone: 'warn' }); }
        else {
          const ok = await confirmDialog({ title: `Nonaktifkan ${target.name}?`, body: 'Tidak bisa login lagi, tapi data project tetap ada dan tetap tampil atas nama ini.', okLabel: 'Nonaktifkan', tone: 'danger' });
          if (ok) {
            try {
              AlurStore.deactivateUser(targetId);
              team = AlurStore.publicUsers();
              audit('', 'user.deactivate', target.name);
              save(); render();
              toast(`${target.name} dinonaktifkan.`, { tone: 'ok' });
            } catch (err) { toast(err.message, { tone: 'warn' }); }
          }
        }
      }
      else if (a === 'restore-user') {
        const targetId = act.dataset.id;
        if (!can('manageUsers')) { toast(denyReason('manageUsers'), { tone: 'warn' }); }
        else {
          AlurStore.restoreUser(targetId);
          team = AlurStore.publicUsers();
          audit('', 'user.restore', targetId);
          save(); render();
          toast('Akun diaktifkan lagi.', { tone: 'ok' });
        }
      }
      else if (a === 'reset-password') {
        const targetId = act.dataset.id;
        if (!can('manageUsers')) { toast(denyReason('manageUsers'), { tone: 'warn' }); }
        else {
          const ok = await confirmDialog({ title: 'Reset password?', body: 'Isi password baru di form edit akun. Lanjutkan?', okLabel: 'Lanjutkan' });
          if (ok) openUserForm(targetId);
        }
      }
      else if (a === 'new-client') openGuarded('editClient', () => openClientForm());
      else if (a === 'open-client') openClientForm(act.dataset.id);
      else if (a === 'delete-client') openGuarded('editClient', () => deleteClient(act.dataset.id));
      else if (a === 'sample') openGuarded('createProject', loadSample);
      else if (a === 'export-excel') exportExcel();
      else if (a === 'sort-dir') { ui.list.sortDir *= -1; ui.list.page = 1; saveUiPrefs(); renderView(); }
      else if (a === 'c-sort-dir') { ui.clientList.sortDir *= -1; ui.clientList.page = 1; renderView(); }
      else if (a === 'filter-stat') {
        const fk = act.dataset.filter; const fv = act.dataset.value;
        ui.list.filters[fk] = ui.list.filters[fk] === fv ? '' : fv;
        ui.list.page = 1; saveUiPrefs(); renderView();
      }
      else if (a === 'reset-filters') {
        ui.list.filters = { stage: '', lead: '', type: '', subtype: '', entity: '', owner: '', qlStatus: '', docs: '', from: '', to: '' };
        ui.list.sortKey = 'changed'; ui.list.sortDir = -1; ui.list.perPage = 50;
        ui.list.page = 1; saveUiPrefs(); renderView();
      }
      else if (a === 'pick-history') { ui.query = act.dataset.q; searchEl.value = act.dataset.q; ui.list.page = 1; ui.clientList.page = 1; renderView(); }
      else if (a === 'clear-history') { clearSearchHistory(); renderView(); }
      else if (a === 'clear-search') { ui.query = ''; searchEl.value = ''; ui.list.page = 1; ui.clientList.page = 1; renderView(); }
      else if (a === 'logout') logout();
      return;
    }
    if (t.closest('.brand')) {
      e.preventDefault();
      setTab('all');
      if (MOBILE()) setSidebar(false);
      return;
    }
    if (t.closest('.ext')) return; // tautan WhatsApp / email

    // Unduhan berkas: isinya ada di IndexedDB, jadi diambil saat diklik.
    const pvDoc = t.closest('[data-preview-doc]');
    if (pvDoc) {
      const [pid, slot] = pvDoc.dataset.previewDoc.split(':');
      const proj = find(pid);
      const meta = proj ? docOf(proj, slot) : null;
      if (!meta) return;
      if (!(await AlurStore.previewFile(meta))) {
        toast('Preview hanya untuk PDF dan gambar. Berkas lain akan diunduh.', { tone: 'warn' });
        await AlurStore.downloadFile(meta);
      }
      return;
    }
    const dlDoc = t.closest('[data-dl-doc]');
    if (dlDoc) {
      const [pid, slot] = dlDoc.dataset.dlDoc.split(':');
      const proj = find(pid);
      if (proj && !(await AlurStore.downloadFile(docOf(proj, slot)))) {
        toast('Berkas tidak ditemukan di penyimpanan browser ini.', { tone: 'warn' });
      }
      return;
    }
    const row = t.closest('.row');
    if (row && viewEl.contains(row)) openRow(row);
  });

  // Baris project membuka panel detail; baris karyawan membuka form edit akun;
  // baris client membuka detail client.
  function openRow(row) {
    if (row.dataset.user) openUserForm(row.dataset.user);
    else if (row.dataset.clientRow) openClientForm(row.dataset.clientRow);
    else openDetail(row.dataset.id);
  }

  // Satu pintu untuk aksi yang butuh role tertentu.
  function openGuarded(cap, run, p = null) {
    if (!can(cap, p)) {
      toast(denyReason(cap, p), { tone: 'warn' });
      return;
    }
    run();
  }

  document.addEventListener('keydown', (e) => {
    const row = e.target.closest('.row');
    if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openRow(row);
      return;
    }
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape' && ui.sidebar && MOBILE()) {
      setSidebar(false);
      openBtn.focus();
      return;
    }
    if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      searchEl.focus();
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      if (ui.page === 'staff') openUserForm();
      else if (ui.page === 'clients') openGuarded('editClient', () => openClientForm());
      else if (ui.page === 'project') openGuarded('createProject', () => openForm());
    } else if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      setSidebar(!ui.sidebar);
    }
  });

  searchEl.addEventListener('input', () => {
    ui.query = searchEl.value;
    ui.list.page = 1;
    ui.clientList.page = 1;
    renderView();
  });
  let searchTimer = 0;
  searchEl.addEventListener('blur', () => {
    if (ui.query.trim()) pushSearchHistory(ui.query);
  });
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && ui.query.trim()) pushSearchHistory(ui.query);
  });

  // Filter tanggal laporan + filter/sorting/pagination daftar.
  // Elemen dibuat ulang setiap render, jadi listener dipasang di viewEl.
  // Simpan Master Data: form-nya dirender ulang, jadi submit didelegasikan.
  viewEl.addEventListener('submit', (e) => {
    if (e.target.id !== 'master-form') return;
    e.preventDefault();
    if (!can('masterData')) { toast(denyReason('masterData'), { tone: 'warn' }); return; }
    const next = readMasterForm();
    const dup = (arr, key) => {
      const seen = new Map();
      for (const it of arr) {
        const k = String(it[key] || '').toLowerCase();
        if (k && seen.has(k)) return it[key];
        seen.set(k, 1);
      }
      return '';
    };
    if (!next.types.length) return masterAlert('Minimal satu tipe project harus ada.');
    if (next.types.some((t) => !t.name)) return masterAlert('Nama tipe tidak boleh kosong.');
    if (next.types.some((t) => !t.prefix)) return masterAlert('Awalan QL tiap tipe wajib diisi.');
    if (dup(next.types, 'name')) return masterAlert(`Nama tipe "${dup(next.types, 'name')}" dipakai dua kali.`);
    if (dup(next.types, 'prefix')) return masterAlert(`Awalan QL "${dup(next.types, 'prefix')}" dipakai dua tipe. Nomor QL bisa tertukar.`);
    const dupSub = next.types.find((t) => dup(t.subtypes.map((s) => ({ s })), 's'));
    if (dupSub) return masterAlert(`Kategori di tipe "${dupSub.name}" ada yang dobel.`);
    if (!next.entities.length) return masterAlert('Minimal satu entitas harus ada.');
    if (next.entities.some((e) => !e.code || !e.name)) return masterAlert('Kode dan nama entitas wajib diisi semua.');
    if (dup(next.entities, 'code')) return masterAlert(`Kode entitas "${dup(next.entities, 'code')}" dipakai dua kali.`);
    if (!next.sources.length) return masterAlert('Minimal satu sumber lead harus ada.');
    if (dup(next.sources.map((s) => ({ s })), 's')) return masterAlert('Sumber lead ada yang dobel.');
    for (const t of next.types) {
      const old = PROJECT_TYPES[t._i];
      if (!old || (old.name === t.name && old.prefix === t.prefix)) continue;
      const candidate = nextQlNoForPrefix(t.prefix, db.qlSeq[t.name] ?? db.qlSeq[old.name]);
      if (qlNoInUse(candidate)) {
        return masterAlert(`Awalan QL "${t.prefix}" akan menghasilkan nomor ${candidate} yang sudah dipakai project lain. Pakai awalan lain.`);
      }
    }
    const removedTypes = PROJECT_TYPES.filter((t) => !next.types.some((n) => PROJECT_TYPES[n._i] === t));
    for (const t of removedTypes) {
      if (usedCount.type(t.name)) return masterAlert(`Tipe "${t.name}" masih dipakai ${usedCount.type(t.name)} project. Ganti nama saja, jangan dihapus.`);
    }
    const removedEnts = ENTITIES.filter((en) => !next.entities.some((n) => ENTITIES[n._i] === en));
    for (const en of removedEnts) {
      if (usedCount.entity(en.code)) return masterAlert(`Entitas "${en.code}" masih dipakai ${usedCount.entity(en.code)} project. Ganti nama saja, jangan dihapus.`);
    }
    // Cegah kategori yatim: kategori yang dihapus dari daftar ditolak bila masih dipakai.
    for (const t of next.types) {
      const old = PROJECT_TYPES[t._i];
      if (!old) continue;
      for (const s of old.subtypes) {
        const stillThere = (t.subtypes || []).includes(s) || t.name !== old.name;
        if (!stillThere && usedCount.subtype(s)) {
          return masterAlert(`Kategori "${s}" di tipe "${old.name}" masih dipakai ${usedCount.subtype(s)} project. Ganti nama atau tanamkan dulu, jangan dihapus mentah.`);
        }
      }
    }
    saveMaster(next);
    toast('Master data disimpan.');
    render();
  });

  // Upload Quotation/RAB/Proposal di Proses QL (drawer, bukan modal Deal).
  detailEl.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-ql-doc]');
    if (!input || !input.files || !input.files[0]) return;
    const slot = input.dataset.qlDoc;
    if (!['quotation', 'rab', 'proposal'].includes(slot)) return;
    const file = input.files[0];
    const p = find(ui.detailId);
    if (!p || p.stage !== 'ql' || !can('editDocs', p)) return;
    if (file.size > MAX_DOC_BYTES) { toast(`${file.name} melebihi 10 MB.`, { tone: 'warn' }); return; }
    try {
      const meta = await AlurStore.putFile(file);
      p.docs = p.docs || {};
      const old = p.docs[slot];
      p.docs[slot] = { ...meta, at: new Date().toISOString(), by: user.id };
      audit(p.id, `doc.${slot}.upload`, meta.name);
      if (old && old.id) AlurStore.deleteFiles([old.id]);
      save(); renderDetail();
      toast(`${DOCS.find((d) => d.id === slot).label} diunggah di Proses QL.`, { tone: 'ok' });
    } catch (err) { toast(`Gagal unggah: ${err.message}`, { tone: 'warn' }); }
  });

  viewEl.addEventListener('change', (e) => {
    const el = e.target;
    if (el.hasAttribute('data-select-all')) {
      viewEl.querySelectorAll('[data-select]').forEach((cb) => {
        if (el.checked) ui.selected.add(cb.dataset.select);
        else ui.selected.delete(cb.dataset.select);
      });
      renderView();
      return;
    }
    if (el.dataset.select) {
      if (el.checked) ui.selected.add(el.dataset.select);
      else ui.selected.delete(el.dataset.select);
      renderView();
      return;
    }
    if (el.id === 'rep-from' || el.id === 'rep-to') {
      const key = el.id === 'rep-from' ? 'from' : 'to';
      ui.report = { ...ui.report, [key]: el.value };
      if (ui.report.from && ui.report.to && ui.report.from > ui.report.to) {
        if (key === 'from') ui.report.to = ui.report.from;
        else ui.report.from = ui.report.to;
      }
      renderView();
      $(`#${el.id}`)?.focus();
      return;
    }
    if (el.dataset.filter) {
      ui.list.filters[el.dataset.filter] = el.value;
      ui.list.page = 1;
      saveUiPrefs();
      renderView();
      return;
    }
    if (el.dataset.sort) {
      if (el.dataset.sort === 'key') ui.list.sortKey = el.value;
      else ui.list.perPage = Number(el.value) || 50;
      ui.list.page = 1;
      saveUiPrefs();
      renderView();
      return;
    }
    if (el.dataset.cfilter) {
      ui.clientList.status = el.value;
      ui.clientList.page = 1;
      renderView();
      return;
    }
    if (el.dataset.csort) {
      if (el.dataset.csort === 'key') ui.clientList.sortKey = el.value;
      else ui.clientList.perPage = Number(el.value) || 50;
      ui.clientList.page = 1;
      renderView();
    }
  });

  // Panah kiri/kanan untuk pindah tab laporan.
  viewEl.addEventListener('keydown', (e) => {
    const rtab = e.target.closest('[data-rtab]');
    if (!rtab || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const i = REPORT_TABS.findIndex((x) => x.id === rtab.dataset.rtab);
    const next = REPORT_TABS[(i + (e.key === 'ArrowRight' ? 1 : -1) + REPORT_TABS.length) % REPORT_TABS.length];
    ui.report.tab = next.id;
    renderView();
    $(`[data-rtab="${next.id}"]`)?.focus();
  });
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchEl.value) {
      e.preventDefault();
      resetSearch();
      renderView();
    }
  });

  // Klik luar menutup panel detail dan konfirmasi; form tidak, agar isian tidak hilang.
  [dlgDetail, dlgConfirm].forEach((d) => {
    let onBackdrop = false;
    d.addEventListener('pointerdown', (ev) => { onBackdrop = ev.target === d; });
    d.addEventListener('click', (ev) => {
      if (onBackdrop && ev.target === d) d.close();
      onBackdrop = false;
    });
  });

  [dlgForm, dlgQl, dlgDeal, dlgClient, dlgUser, dlgBulkUser, dlgConfirm, dlgDetail].forEach((d) => d.addEventListener('close', () => {
    if (d.contains(toastRegion)) document.body.appendChild(toastRegion);
  }));
  dlgDetail.addEventListener('close', () => { ui.detailId = null; });

  // Sinkron antar tab browser.
  window.addEventListener('storage', (e) => {
    if (e.key === AlurStore.KEYS.data) {
      db = AlurStore.loadData();
      db.projects = db.projects.filter(valid);
      render();
    } else if (e.key === AlurStore.KEYS.users) {
      team = AlurStore.publicUsers();
      const me = team.find((u) => u.id === user.id);
      if (me) user = me;
      render();
    } else if (e.key === AlurStore.KEYS.session && !AlurStore.currentUser()) {
      location.replace('login.html');
    }
  });

  // ---------------------------------------------------------------------------
  // Data contoh
  // ---------------------------------------------------------------------------
  function loadSample() {
    if (db.projects.length) {
      toast('Data contoh hanya bisa dimuat saat pipeline masih kosong.', { tone: 'warn' });
      return;
    }
    const now = Date.now();
    const iso = (d, i) => new Date(now - d * DAY - ((i * 37) % 9) * 3600000).toISOString();
    const day = (offset) => {
      const d = new Date(now + offset * DAY);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const ids = team.map((u) => u.id);
    const pick = (...n) => n.map((i) => ids[i % ids.length]).filter(Boolean);
    // Entitas data contoh: tiap tipe project dipegang satu badan usaha supaya
    // laporan per entitas langsung terlihat. Di form, keduanya tetap bebas.
    const SAMPLE_ENTITY = {
      'Prasasti Selaras': 'PSS',
      'Prasasti Lestari': 'PWS',
      'Mutiari Garden': 'MGI',
      'Mutiari Decoration': 'MAW',
      'Wood and Steel': 'PS',
    };

    const rows = [
      ['Dekorasi Pernikahan Gedung Arjuna', 'Mutiari Decoration', '', 12, 12, 'hot', 'Instagram', 'PT Arjuna Graha', 'Bu Maya', '6281233008812', 'maya@arjunagraha.co.id', 'Pelaminan utama + photobooth.', pick(0, 1), [['lead', 42], ['ql', 33], ['deal', 19]], 'proses', 185e6],
      ['Family Gathering PT Baja Mandiri', 'Prasasti Selaras', 'Family Gathering', 25, 27, 'hot', 'Repeat Order', 'PT Baja Mandiri', 'Pak Hendra', '628118904421', 'hendra@bajamandiri.com', 'Peserta 220 orang, lokasi Puncak.', pick(2), [['lead', 38], ['ql', 26], ['deal', 7]], 'proses', 420e6],
      ['Taman Kantor Pusat Mutiari', 'Mutiari Garden', 'Taman (landscape)', 40, 47, 'hot', 'Direct Selling', 'PT Hijau Lestari', 'Bu Ratna', '6285710203344', '', 'Luas ±600 m², termasuk perawatan 3 bulan.', pick(1, 3, 4), [['lead', 34], ['ql', 20], ['deal', 11]], 'proses', 310e6],
      ['Booth Pameran Otomotif', 'Wood and Steel', 'Booth', -5, -3, 'hot', 'SEO', 'Hotel Sekar Wangi', 'Pak Gunawan', '628129004421', 'ga@sekarwangi.id', '', pick(3), [['lead', 30], ['ql', 22], ['lost', 9, 'Client memilih vendor dengan harga lebih rendah.']], 'belum', 96e6],
      ['Program CSR Bank Daerah', 'Prasasti Lestari', 'CSR', 18, 18, 'cold', 'Blast Email', 'PT Fintek Andalan', 'Pak Bayu', '6282155129080', 'bayu@fintekandalan.com', 'Sudah dikirim penawaran, lalu tidak ada kabar.', pick(4), [['lead', 30], ['ql', 26], ['lost', 14, 'Tidak ada respons setelah tiga kali tindak lanjut.']], 'belum', 28e6],
      ['Gala Dinner Akhir Tahun', 'Prasasti Selaras', 'Gala Dinner', 55, 55, 'hot', 'Iklan IG', 'PT Cahaya Energi', 'Pak Fajar', '6281390901212', 'fajar@cahayaenergi.co.id', 'Tema klasik, kapasitas 400 kursi.', pick(0, 2), [['lead', 21], ['ql', 12]], 'proses', 240e6],
      ['Souvenir Custom Tumbler', 'Wood and Steel', 'Tumbler', 30, 32, 'hot', 'Iklan Website', 'CV Mitra Baja Utama', 'Pak Yusuf', '6281322017765', '', 'Minta sample sebelum produksi massal.', pick(5), [['lead', 17], ['ql', 4]], 'belum', 54e6],
      ['Vertical Garden Lobi Rumah Sakit', 'Mutiari Garden', 'Vertical Garden', 62, 64, 'hot', 'Telemarketing', 'RS Harapan Bunda', 'Bu Lestari', '6289644102231', 'umum@rsharapanbunda.co.id', 'Perlu presentasi ke manajemen.', pick(1, 5), [['lead', 15], ['ql', 2]], 'proses', 128e6],
      ['Team Building Yayasan Cendekia', 'Prasasti Selaras', 'Team Building', 0, 0, 'cold', 'Iklan Tiktok', 'Yayasan Cendekia', 'Pak Anton', '6281270001290', '', 'Tanggal kegiatan belum ditentukan client. Masih membandingkan beberapa vendor.', pick(2, 4), [['lead', 11]], '', 0],
      ['Awarding Night Nusantara Food', 'Prasasti Selaras', 'Awarding', 90, 90, 'hot', 'Direct Selling', 'PT Nusantara Food', 'Mbak Dewi', '6282155129081', 'dewi@nusantarafood.id', 'Kapasitas 300 tamu.', pick(0), [['lead', 6]], '', 0],
      ['Hampers Anggrek Lebaran', 'Mutiari Garden', 'Hampers Anggrek', 120, 120, 'cold', 'Instagram', 'PT Hijau Lestari', 'Bu Ratna', '6285710203344', '', 'Baru menanyakan estimasi biaya per unit.', pick(3), [['lead', 3]], '', 0],
      ['Outing Divisi Produksi', 'Prasasti Selaras', 'Employee Gathering', 0, 0, 'hot', 'Repeat Order', 'PT Sinar Abadi Logistik', 'Pak Dimas', '6281288901123', 'dimas@sinarabadi.co.id', 'Jadwal menunggu kalender HRD.', pick(1), [['lead', 1]], '', 0],
      ['Aquascape Ruang Tunggu', 'Mutiari Garden', 'Aquascape', 35, 38, 'cold', 'SEO', 'PT Baja Mandiri', 'Pak Hendra', '628118904421', 'hendra@bajamandiri.com', 'Repeat order setelah Family Gathering.', pick(4, 0), [['lead', 0]], '', 0],
    ];

    let dealSeen = 0;
    rows.forEach(([name, type, subtype, startOff, endOff, lead, source, company, clientPic, wa, email, desc, owners, path, qlStatus, offer], i) => {
      // Nomor QL hanya diterbitkan untuk project yang pernah masuk Proses QL.
      const qlStep = path.find(([st]) => st === 'ql');
      const qlNo = qlStep ? takeQlNo(type) : '';
      const history = path.map(([stage, d, note]) => {
        const entry = { stage, at: iso(d, i), by: owners[0] || user.id };
        if (note) entry.note = note;
        if (stage === 'ql' && qlNo) entry.qlNo = qlNo;
        return entry;
      });
      const last = history[history.length - 1];
      // Tanggal kegiatan boleh kosong; offset 0 pada data contoh berarti belum dijadwalkan.
      const scheduled = startOff !== 0 || endOff !== 0;
      const dealValue = last.stage === 'deal' ? offer : 0;
      // Beberapa baris memakai perusahaan yang sama, jadi client-nya dipakai ulang.
      const client = upsertClient({ name: company, pic: clientPic, wa, email });
      if (last.stage === 'deal') dealSeen += 1;
      db.projects.push({
        id: nextId(), name, type, subtype, entity: SAMPLE_ENTITY[type] || '',
        start: scheduled ? day(startOff) : '', end: scheduled ? day(endOff) : '',
        lead, source, clientId: client.id, desc,
        owners, stage: last.stage,
        qlNo, qlStatus: qlNo ? (qlStatus || 'belum') : '', qlNote: '',
        qlAt: qlStep ? iso(qlStep[1], i) : '', offer: qlNo ? offer : 0,
        dealValue,
        docs: {},
        createdAt: history[0].at, createdBy: history[0].by,
        stageChangedAt: last.at, history,
      });
    });
    save();
    render();
    toast(`${rows.length} project contoh dimuat.`, { tone: 'ok' });
  }

  render();
})();
