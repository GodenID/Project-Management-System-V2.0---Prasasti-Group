'use strict';

const crypto = require('node:crypto');
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  ListObjectsV2Command, DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { pool, initDb } = require('./db');

const app = Fastify({ logger: true, trustProxy: true });

const metrics = { requests: 0, errors: 0, startedAt: Date.now() };
app.addHook('onRequest', async () => { metrics.requests += 1; });
app.addHook('onError', async () => { metrics.errors += 1; });

async function currentRev(client = pool) {
  const { rows } = await client.query("SELECT rev FROM sync_state WHERE key = 'main'");
  return rows.length ? Number(rows[0].rev) : 0;
}
async function bumpRev(client = pool) {
  await client.query("UPDATE sync_state SET rev = rev + 1 WHERE key = 'main'");
  return currentRev(client);
}

app.register(cors, {
  origin: (process.env.FRONTEND_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean),
  credentials: true,
});

const PORT = Number(process.env.PORT || 3000);
const API_TOKENS = new Set((process.env.API_TOKENS || '').split(',').map((s) => s.trim()).filter(Boolean));

const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_REGION = process.env.S3_REGION || 'auto';
const DOC_PROXY_SECRET = process.env.DOC_PROXY_SECRET || '';
const DOC_PROXY_HOST = process.env.DOC_PROXY_HOST || 'https://docs.prasastigroup.id';

function signDocToken(s3Url, opts = {}) {
  const payload = Buffer.from(JSON.stringify({
    u: s3Url, e: Date.now() + 10 * 60 * 1000,
    d: Boolean(opts.d), n: String(opts.n || '').slice(0, 180),
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', DOC_PROXY_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
const s3 = S3_BUCKET ? new S3Client({
  region: S3_REGION,
  endpoint: process.env.S3_ENDPOINT || undefined,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
}) : null;

function safeSegment(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'tanpa-nama';
}

const QL_PREFIX = {
  'Prasasti Selaras': 'PSQL',
  'Prasasti Lestari': 'PLQL',
  'Mutiari Garden': 'MGQL',
  'Mutiari Decoration': 'MDQL',
  'Wood and Steel': 'WSQL',
};

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function newId(prefix) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (const b of bytes) code += chars[b % chars.length];
  return `${prefix}-${code}`;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    mustChangePassword: Boolean(row.must_change_password),
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  };
}

async function authPreHandler(request, reply) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return reply.code(401).send({ message: 'Bearer token wajib.' });
  if (API_TOKENS.has(token)) {
    request.user = { id: 'api', name: 'API Finance', role: 'admin', must_change_password: false };
    return;
  }
  const { rows } = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND u.deleted_at IS NULL`,
    [sha256(token)],
  );
  if (!rows.length) return reply.code(401).send({ message: 'Token tidak valid.' });
  request.user = rows[0];
}

async function adminPreHandler(request, reply) {
  await authPreHandler(request, reply);
  if (reply.sent) return;
  if (request.user.role !== 'admin') return reply.code(403).send({ message: 'Admin saja.' });
}

async function seedUsers() {
  const { rowCount } = await pool.query('SELECT 1 FROM users LIMIT 1');
  if (rowCount) return;
  const seeds = [
    ['goden', 'Goden', 'admin', 'lebahganteng'],
    ['dimas', 'Dimas Prakoso', 'manager', 'demo123'],
    ['sari', 'Sari Wulandari', 'finance', 'demo123'],
    ['bagus', 'Bagus Hartono', 'user', 'demo123'],
    ['nadia', 'Nadia Putri', 'user', 'demo123'],
    ['yoga', 'Yoga Saputra', 'user', 'demo123'],
  ];
  for (const [username, name, role, password] of seeds) {
    await pool.query(
      `INSERT INTO users (id, name, username, role, password_hash, must_change_password)
       VALUES ($1, $2, $3, $4, $5, FALSE) ON CONFLICT (username) DO NOTHING`,
      [newId('u'), name, username, role, hashPassword(password)],
    );
  }
}

app.get('/api/health', async () => ({ ok: true, service: 'prasasti-pms-api', at: new Date().toISOString() }));

app.post('/api/auth/login', async (request, reply) => {
  const { username, password } = request.body || {};
  if (!username || !password) return reply.code(400).send({ message: 'Username dan password wajib.' });
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE username = $1 AND deleted_at IS NULL',
    [String(username).trim().toLowerCase()],
  );
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    return reply.code(401).send({ message: 'Username atau password salah.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)', [sha256(token), user.id]);
  return { token, user: publicUser(user) };
});

app.get('/api/auth/me', { preHandler: authPreHandler }, async (request) => ({ user: publicUser(request.user) }));

app.post('/api/auth/change-password', { preHandler: authPreHandler }, async (request, reply) => {
  const { password } = request.body || {};
  if (!password || String(password).length < 6) {
    return reply.code(400).send({ message: 'Password minimal 6 karakter.' });
  }
  await pool.query(
    'UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2',
    [hashPassword(password), request.user.id],
  );
  return { ok: true };
});

app.get('/api/clients', { preHandler: authPreHandler }, async (request) => {
  const q = String(request.query.q || '').trim();
  const limit = Math.min(Number(request.query.limit || 50), 200);
  const offset = Number(request.query.offset || 0);
  const params = [`%${q}%`];
  const where = q ? 'WHERE name ILIKE $1 OR pic ILIKE $1 OR wa ILIKE $1' : '';
  const count = await pool.query(`SELECT count(*)::int AS total FROM clients ${where}`, params);
  const data = await pool.query(
    `SELECT * FROM clients ${where} ORDER BY name ASC LIMIT $2 OFFSET $3`,
    [...params, limit, offset],
  );
  return { total: count.rows[0].total, items: data.rows };
});

app.get('/api/projects', { preHandler: authPreHandler }, async (request) => {
  const q = String(request.query.q || '').trim();
  const stage = String(request.query.stage || '');
  const limit = Math.min(Number(request.query.limit || 50), 200);
  const offset = Number(request.query.offset || 0);
  const clauses = ['p.deleted_at IS NULL'];
  const params = [];
  if (q) { params.push(`%${q}%`); clauses.push(`(p.name ILIKE $${params.length} OR p.ql_no ILIKE $${params.length} OR p.po_no ILIKE $${params.length})`); }
  if (stage) { params.push(stage); clauses.push(`p.stage = $${params.length}`); }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const count = await pool.query(`SELECT count(*)::int AS total FROM projects p ${where}`, params);
  const data = await pool.query(
    `SELECT p.*, c.name AS client_name,
      COALESCE(array_agg(o.user_id) FILTER (WHERE o.user_id IS NOT NULL), '{}') AS owners
     FROM projects p LEFT JOIN clients c ON c.id = p.client_id
     LEFT JOIN project_owners o ON o.project_id = p.id
     ${where} GROUP BY p.id, c.name
     ORDER BY p.stage_changed_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return { total: count.rows[0].total, items: data.rows };
});

app.get('/api/projects/:id', { preHandler: authPreHandler }, async (request, reply) => {
  const { rows } = await pool.query(
    `SELECT p.*, c.name AS client_name,
      COALESCE(array_agg(o.user_id) FILTER (WHERE o.user_id IS NOT NULL), '{}') AS owners
     FROM projects p LEFT JOIN clients c ON c.id = p.client_id
     LEFT JOIN project_owners o ON o.project_id = p.id
     WHERE p.id = $1 AND p.deleted_at IS NULL GROUP BY p.id, c.name`,
    [request.params.id],
  );
  if (!rows.length) return reply.code(404).send({ message: 'Project tidak ditemukan.' });
  return { project: rows[0] };
});

app.post('/api/projects', { preHandler: authPreHandler }, async (request, reply) => {
  const b = request.body || {};
  if (!b.name) return reply.code(400).send({ message: 'Nama project wajib.' });
  const id = newId('PROJECT');
  const client = new Date().toISOString();
  await pool.query(
    `INSERT INTO projects
      (id, name, type, subtype, entity, client_id, stage, lead_kind, source, start_date, end_date, description, created_by, stage_changed_at)
     VALUES ($1,$2,$3,$4,$5,$6,'lead',$7,$8,$9,$10,$11,$12,$13)`,
    [id, b.name, b.type || '', b.subtype || '', b.entity || '', b.clientId || null,
      b.leadKind || 'cold', b.source || '', b.startDate || null, b.endDate || null,
      b.description || '', request.user.id, client],
  );
  const owners = Array.isArray(b.owners) && b.owners.length ? b.owners : [request.user.id];
  for (const uid of owners) {
    await pool.query('INSERT INTO project_owners (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, uid]);
  }
  await pool.query('INSERT INTO audit_log (project_id, by_user, action, detail) VALUES ($1,$2,$3,$4)', [id, request.user.id, 'project.create', b.name]);
  return reply.code(201).send({ id });
});

async function allocateNumber(request, reply, kind) {
  const key = String(request.body?.idempotencyKey || '');
  if (!key) return reply.code(400).send({ message: 'idempotencyKey wajib.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT response FROM idempotency WHERE key = $1 FOR UPDATE', [key]);
    if (existing.rows.length) {
      await client.query('COMMIT');
      return existing.rows[0].response;
    }
    let projectId = String(request.body.projectId || '');
    let type = String(request.body.type || '');
    if (!projectId) {
      const generated = newId('PROJECT');
      await client.query('INSERT INTO projects (id, name) VALUES ($1, $2)', [generated, 'Project dari Finance']);
      projectId = generated;
    }
    const project = await client.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
    if (!project.rows.length) { await client.query('ROLLBACK'); return reply.code(404).send({ message: 'Project tidak ditemukan.' }); }
    const column = kind === 'ql' ? 'ql_no' : 'po_no';
    if (project.rows[0][column]) {
      await client.query('INSERT INTO idempotency (key, response) VALUES ($1, $2) ON CONFLICT DO NOTHING', [key, JSON.stringify({ [column]: project.rows[0][column] })]);
      await client.query('COMMIT');
      return { [column]: project.rows[0][column] };
    }
    if (kind === 'ql' && !type) type = project.rows[0].type || '';
    const scope = kind === 'ql' ? type : 'global';
    const prefix = kind === 'ql' ? (QL_PREFIX[type] || 'XXQL') : 'PO';
    await client.query(
      `INSERT INTO number_sequences (kind, scope, next_value) VALUES ($1,$2,1)
       ON CONFLICT (kind, scope) DO NOTHING`,
      [kind, scope],
    );
    const seq = await client.query('SELECT next_value FROM number_sequences WHERE kind = $1 AND scope = $2 FOR UPDATE', [kind, scope]);
    let next = seq.rows[0].next_value;
    let number = '';
    for (let guard = 0; guard < 10000; guard += 1) {
      number = `${prefix}-${String(next).padStart(4, '0')}`;
      const used = await client.query(`SELECT 1 FROM projects WHERE ${column} = $1`, [number]);
      if (!used.rowCount) break;
      next += 1;
    }
    await client.query('UPDATE number_sequences SET next_value = $2 WHERE kind = $1 AND scope = $3', [kind, next + 1, scope]);
    await client.query(`UPDATE projects SET ${column} = $2 WHERE id = $1`, [projectId, number]);
    await client.query(
      'INSERT INTO project_history (project_id, stage, by_user, note, ql_no) VALUES ($1,$2,$3,$4,$5)',
      [projectId, kind === 'ql' ? 'ql' : 'deal', request.user.id, `Nomor ${kind} ${number}`, kind === 'ql' ? number : null],
    );
    const response = { [column]: number };
    await client.query('INSERT INTO idempotency (key, response) VALUES ($1, $2)', [key, JSON.stringify(response)]);
    await client.query('COMMIT');
    return response;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

app.post('/api/numbers/ql', { preHandler: authPreHandler }, (request, reply) => allocateNumber(request, reply, 'ql'));
app.post('/api/numbers/po', { preHandler: authPreHandler }, (request, reply) => allocateNumber(request, reply, 'po'));

app.get('/api/projects/:id/numbers', { preHandler: authPreHandler }, async (request, reply) => {
  const { rows } = await pool.query('SELECT ql_no, po_no FROM projects WHERE id = $1', [request.params.id]);
  if (!rows.length) return reply.code(404).send({ message: 'Project tidak ditemukan.' });
  return rows[0];
});

app.get('/api/users', { preHandler: adminPreHandler }, async () => {
  const { rows } = await pool.query('SELECT id, name, username, role, must_change_password, deleted_at, created_at FROM users ORDER BY name');
  return { items: rows.map(publicUser) };
});

app.post('/api/users', { preHandler: adminPreHandler }, async (request, reply) => {
  const b = request.body || {};
  if (!b.name || !b.username || !b.password) return reply.code(400).send({ message: 'Nama, username, dan password wajib.' });
  const id = newId('u');
  try {
    await pool.query(
      `INSERT INTO users (id, name, username, role, password_hash, must_change_password)
       VALUES ($1,$2,$3,$4,$5,TRUE)`,
      [id, b.name, String(b.username).trim().toLowerCase(), b.role || 'user', hashPassword(b.password)],
    );
  } catch (err) {
    if (err.code === '23505') return reply.code(409).send({ message: 'Username sudah dipakai.' });
    throw err;
  }
  return reply.code(201).send({ id });
});

app.patch('/api/users/:id', { preHandler: authPreHandler }, async (request, reply) => {
  if (request.user.role !== 'admin' && request.user.id !== request.params.id) {
    return reply.code(403).send({ message: 'Admin atau pemilik akun saja.' });
  }
  const b = request.body || {};
  if (request.user.role !== 'admin' && b.role && b.role !== request.user.role) {
    return reply.code(403).send({ message: 'Role hanya bisa diubah Admin.' });
  }
  const sets = [];
  const params = [];
  for (const [field, value] of [['name', b.name], ['role', b.role], ['username', b.username]]) {
    if (value !== undefined) { params.push(value); sets.push(`${field} = $${params.length}`); }
  }
  if (b.password) { params.push(hashPassword(b.password)); sets.push(`password_hash = $${params.length}`); sets.push('must_change_password = TRUE'); }
  if (b.deactivate === true) { sets.push('deleted_at = now()'); }
  if (b.deactivate === false) { sets.push('deleted_at = NULL'); }
  if (!sets.length) return reply.code(400).send({ message: 'Tidak ada perubahan.' });
  params.push(request.params.id);
  const { rowCount } = await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  if (!rowCount) return reply.code(404).send({ message: 'User tidak ditemukan.' });
  return { ok: true };
});

app.post('/api/auth/verify', { preHandler: authPreHandler }, async (request) => {
  const password = String(request.body?.password || '');
  return { ok: verifyPassword(password, request.user.password_hash) };
});

app.post('/api/users/:id/reset-password', { preHandler: adminPreHandler }, async (request, reply) => {
  const password = String(request.body?.password || '');
  if (password.length < 6) return reply.code(400).send({ message: 'Password minimal 6 karakter.' });
  const { rowCount } = await pool.query(
    'UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2',
    [hashPassword(password), request.params.id],
  );
  if (!rowCount) return reply.code(404).send({ message: 'User tidak ditemukan.' });
  return { ok: true };
});

app.delete('/api/users/:id', { preHandler: adminPreHandler }, async (request, reply) => {
  const id = request.params.id;
  if (id === request.user.id) return reply.code(400).send({ message: 'Tidak bisa menghapus akun sendiri.' });
  const target = await pool.query('SELECT id, role FROM users WHERE id = $1', [id]);
  if (!target.rows.length) return reply.code(404).send({ message: 'Karyawan tidak ditemukan.' });
  if (target.rows[0].role === 'admin') {
    const admins = await pool.query("SELECT count(*)::int AS total FROM users WHERE role = 'admin'");
    if (admins.rows[0].total <= 1) return reply.code(400).send({ message: 'Admin terakhir tidak bisa dihapus.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await client.query('DELETE FROM project_owners WHERE user_id = $1', [id]);
    await client.query('DELETE FROM users WHERE id = $1', [id]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

app.post('/api/files', { preHandler: authPreHandler }, async (request, reply) => {
  if (!s3) return reply.code(503).send({ message: 'S3 belum dikonfigurasi di server.' });
  const b = request.body || {};
  const projectId = String(b.projectId || '');
  const slot = String(b.slot || '');
  const name = String(b.name || '');
  const data = String(b.data || '');
  if (!projectId || !slot || !name || !data) {
    return reply.code(400).send({ message: 'projectId, slot, name, dan data wajib.' });
  }
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) return reply.code(400).send({ message: 'Berkas kosong.' });
  if (bytes.length > 10 * 1024 * 1024) return reply.code(400).send({ message: 'Berkas melebihi 10 MB.' });
  const project = await pool.query('SELECT id, name FROM projects WHERE id = $1', [projectId]);
  if (!project.rows.length) return reply.code(404).send({ message: 'Project tidak ditemukan.' });
  const username = String(request.user.username || b.username || 'api');
  const revRes = await pool.query(
    'SELECT COALESCE(MAX(rev), 0) + 1 AS rev FROM documents WHERE project_id = $1 AND slot = $2',
    [projectId, slot],
  );
  const rev = Number(revRes.rows[0].rev || 1);
  const key = `${safeSegment(username)}/${safeSegment(project.rows[0].name)}/${safeSegment(slot)}/rev-${rev}-${safeSegment(name)}`;
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: bytes,
    ContentType: String(b.type || 'application/octet-stream'),
  }));
  const id = newId('f');
  const at = new Date().toISOString();
  await pool.query(
    `INSERT INTO documents (id, project_id, slot, rev, file_key, name, size, mime, uploaded_by, uploaded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, projectId, slot, rev, key, name, bytes.length, String(b.type || ''), request.user.id || null, at],
  );
  return {
    id, name, size: bytes.length, type: String(b.type || ''), key, rev, at,
    by: request.user.id || '', username, syncRev: await bumpRev(),
  };
});

app.post('/api/files/presign', { preHandler: authPreHandler }, async (request, reply) => {
  if (!s3) return reply.code(503).send({ message: 'S3 belum dikonfigurasi di server.' });
  const b = request.body || {};
  const projectId = String(b.projectId || '');
  const slot = String(b.slot || '');
  const name = String(b.name || '');
  const size = Number(b.size || 0);
  if (!projectId || !slot || !name || !size) {
    return reply.code(400).send({ message: 'projectId, slot, name, dan size wajib.' });
  }
  if (size > 10 * 1024 * 1024) return reply.code(400).send({ message: 'Berkas melebihi 10 MB.' });
  const project = await pool.query('SELECT id, name FROM projects WHERE id = $1', [projectId]);
  if (!project.rows.length) return reply.code(404).send({ message: 'Project tidak ditemukan.' });
  const username = String(request.user.username || b.username || 'api');
  const revRes = await pool.query(
    'SELECT COALESCE(MAX(rev), 0) + 1 AS rev FROM documents WHERE project_id = $1 AND slot = $2',
    [projectId, slot],
  );
  const rev = Number(revRes.rows[0].rev || 1);
  const id = newId('f');
  const key = `${safeSegment(username)}/${safeSegment(project.rows[0].name)}/${safeSegment(slot)}/rev-${rev}-${safeSegment(name)}`;
  const type = String(b.type || 'application/octet-stream');
  const url = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: S3_BUCKET, Key: key, ContentType: type,
  }), { expiresIn: 300 });
  return { id, key, rev, url };
});

app.post('/api/files/confirm', { preHandler: authPreHandler }, async (request, reply) => {
  if (!s3) return reply.code(503).send({ message: 'S3 belum dikonfigurasi di server.' });
  const b = request.body || {};
  const id = String(b.id || '');
  const key = String(b.key || '');
  if (!id || !key) return reply.code(400).send({ message: 'id dan key wajib.' });
  const at = new Date().toISOString();
  await pool.query(
    `INSERT INTO documents (id, project_id, slot, rev, file_key, name, size, mime, uploaded_by, uploaded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, size = EXCLUDED.size, mime = EXCLUDED.mime, uploaded_at = EXCLUDED.uploaded_at`,
    [id, b.projectId || '', b.slot || '', Number(b.rev || 1), key, b.name || '',
      Number(b.size || 0), b.type || '', request.user.id || null, at],
  );
  return {
    id, key, rev: Number(b.rev || 1), name: b.name || '', size: Number(b.size || 0),
    type: b.type || '', at, by: request.user.id || '', syncRev: await bumpRev(),
  };
});

app.get('/api/files/:id/url', { preHandler: authPreHandler }, async (request, reply) => {
  if (!s3) return reply.code(503).send({ message: 'S3 belum dikonfigurasi di server.' });
  const { rows } = await pool.query('SELECT * FROM documents WHERE id = $1', [request.params.id]);
  if (!rows.length) return reply.code(404).send({ message: 'Berkas tidak ditemukan.' });
  const doc = rows[0];
  if (!doc.file_key || !String(doc.file_key).includes('/')) {
    return reply.code(409).send({ message: 'Dokumen lama belum termigrasi ke S3. Simpan/muat ulang project sekali lagi.' });
  }
  const s3Url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: doc.file_key }), { expiresIn: 600 });
  const download = request.query?.mode === 'download';
  const url = DOC_PROXY_SECRET
    ? `${DOC_PROXY_HOST}/f/${encodeURIComponent(doc.id)}?t=${encodeURIComponent(signDocToken(s3Url, { d: download, n: doc.name }))}`
    : s3Url;
  return { url, name: doc.name, type: doc.mime || '' };
});

app.post('/api/files/delete', { preHandler: authPreHandler }, async (request, reply) => {
  if (!s3) return reply.code(503).send({ message: 'S3 belum dikonfigurasi di server.' });
  const ids = Array.isArray(request.body?.ids) ? request.body.ids : [];
  for (const id of ids) {
    const { rows } = await pool.query('SELECT file_key FROM documents WHERE id = $1', [id]);
    if (!rows.length || !rows[0].file_key) continue;
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: rows[0].file_key }));
    await pool.query('DELETE FROM documents WHERE id = $1', [id]);
  }
  return { ok: true, deleted: ids.length, syncRev: await bumpRev() };
});

app.post('/api/projects/delete', { preHandler: authPreHandler }, async (request, reply) => {
  if (!['admin', 'manager'].includes(request.user.role)) {
    return reply.code(403).send({ message: 'Hanya Manager atau Admin yang bisa menghapus permanen.' });
  }
  const ids = (Array.isArray(request.body?.ids) ? request.body.ids : []).map(String).filter(Boolean);
  if (!ids.length) return { ok: true, deleted: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of ids) {
      const docs = await client.query('SELECT file_key FROM documents WHERE project_id = $1', [id]);
      if (s3) {
        for (const d of docs.rows) {
          if (d.file_key) await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: d.file_key }));
        }
      }
      await client.query('DELETE FROM documents WHERE project_id = $1', [id]);
      await client.query('DELETE FROM project_history WHERE project_id = $1', [id]);
      await client.query('DELETE FROM project_owners WHERE project_id = $1', [id]);
      await client.query('DELETE FROM audit_log WHERE project_id = $1', [id]);
      await client.query('DELETE FROM projects WHERE id = $1', [id]);
    }
    const nextRev = await bumpRev(client);
    await client.query('COMMIT');
    return { ok: true, deleted: ids.length, syncRev: nextRev };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

app.post('/api/reset', { preHandler: adminPreHandler }, async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const docs = await client.query('SELECT file_key FROM documents');
    if (s3) {
      for (const d of docs.rows) {
        if (d.file_key) await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: d.file_key }));
      }
    }
    await client.query('DELETE FROM documents');
    await client.query('DELETE FROM project_history');
    await client.query('DELETE FROM project_owners');
    await client.query('DELETE FROM audit_log');
    await client.query('DELETE FROM projects');
    await client.query('DELETE FROM clients');
    await client.query('DELETE FROM app_master');
    await client.query('DELETE FROM number_sequences');
    await client.query('DELETE FROM idempotency');
    await client.query('DELETE FROM users WHERE role <> $1', ['admin']);
    await client.query('DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users)');
    const nextRev = await bumpRev(client);
    await client.query('COMMIT');
    return { ok: true, syncRev: nextRev };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

function iso(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function dateOnly(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function projectToFront(row, owners, history, docs) {
  return {
    id: row.id,
    name: row.name,
    type: row.type || '',
    subtype: row.subtype || '',
    entity: row.entity || '',
    clientId: row.client_id || '',
    stage: row.stage || 'lead',
    qlNo: row.ql_no || '',
    poNo: row.po_no || '',
    lead: row.lead_kind || 'cold',
    source: row.source || '',
    qlStatus: row.ql_status || '',
    qlNote: row.ql_note || '',
    offer: Number(row.offer || 0),
    dealValue: Number(row.deal_value || 0),
    start: dateOnly(row.start_date),
    end: dateOnly(row.end_date),
    desc: row.description || '',
    owners,
    createdAt: iso(row.created_at),
    createdBy: row.created_by || '',
    stageChangedAt: iso(row.stage_changed_at),
    deletedAt: iso(row.deleted_at),
    deletedBy: '',
    history: history.map((h) => ({
      stage: h.stage,
      at: iso(h.at),
      by: h.by_user || '',
      note: h.note || '',
      ...(h.ql_no ? { qlNo: h.ql_no } : {}),
    })),
    docs,
  };
}

async function getSnapshot() {
  const [users, clients, projects, owners, history, documents, audit, master] = await Promise.all([
    pool.query('SELECT * FROM users ORDER BY name'),
    pool.query('SELECT * FROM clients ORDER BY name'),
    pool.query('SELECT * FROM projects ORDER BY stage_changed_at DESC'),
    pool.query('SELECT * FROM project_owners'),
    pool.query('SELECT * FROM project_history ORDER BY at ASC'),
    pool.query('SELECT * FROM documents ORDER BY rev ASC'),
    pool.query('SELECT * FROM audit_log ORDER BY at ASC'),
    pool.query("SELECT value FROM app_master WHERE key = 'master'"),
  ]);

  const ownersByProject = new Map();
  for (const o of owners.rows) {
    const list = ownersByProject.get(o.project_id) || [];
    list.push(o.user_id);
    ownersByProject.set(o.project_id, list);
  }
  const historyByProject = new Map();
  for (const h of history.rows) {
    const list = historyByProject.get(h.project_id) || [];
    list.push(h);
    historyByProject.set(h.project_id, list);
  }
  const docsByProject = new Map();
  for (const d of documents.rows) {
    const slots = docsByProject.get(d.project_id) || {};
    const revs = slots[d.slot] || [];
    revs.push({
      id: d.id, key: d.file_key, name: d.name, size: Number(d.size || 0), type: d.mime || '',
      at: iso(d.uploaded_at), by: d.uploaded_by || '', rev: d.rev,
    });
    slots[d.slot] = revs;
    docsByProject.set(d.project_id, slots);
  }
  const docs = {};
  for (const [pid, slots] of docsByProject) {
    docs[pid] = {};
    for (const [slot, revs] of Object.entries(slots)) {
      const latest = revs[revs.length - 1];
      docs[pid][slot] = { ...latest, history: revs };
    }
  }

  return {
    syncRev: await currentRev(),
    seq: projects.rows.length,
    qlSeq: {},
    poSeq: 0,
    users: users.rows.map(publicUser),
    clients: clients.rows,
    projects: projects.rows.map((p) => projectToFront(
      p,
      ownersByProject.get(p.id) || [],
      historyByProject.get(p.id) || [],
      docs[p.id] || {},
    )),
    audit: audit.rows.map((a) => ({
      id: String(a.id), projectId: a.project_id || '', at: iso(a.at),
      by: a.by_user || '', byName: a.by_user || '', action: a.action, detail: a.detail || '',
    })),
    master: master.rows[0]?.value || null,
    masterHistory: [],
  };
}

app.get('/api/snapshot', { preHandler: authPreHandler }, async () => getSnapshot());

app.post('/api/sync', { preHandler: authPreHandler }, async (request, reply) => {
  const body = request.body || {};
  if (!Array.isArray(body.projects) || !Array.isArray(body.clients)) {
    return reply.code(400).send({ message: 'projects dan clients wajib array.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT rev FROM sync_state WHERE key = 'main' FOR UPDATE");
    const rev = await currentRev(client);
    if (Number(body.baseRev) !== rev) {
      await client.query('ROLLBACK');
      return reply.code(409).send({
        message: 'Data berubah di tab lain. Muat ulang halaman.', syncRev: rev,
      });
    }
    for (const c of body.clients) {
      await client.query(
        `INSERT INTO clients (id, name, pic, wa, email, notes, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()))
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, pic = EXCLUDED.pic, wa = EXCLUDED.wa,
           email = EXCLUDED.email, notes = EXCLUDED.notes`,
        [c.id, c.name || '', c.pic || '', c.wa || '', c.email || '', c.notes || '', c.createdBy || null, c.createdAt || null],
      );
    }
    if (Array.isArray(body.users)) {
      for (const u of body.users) {
        if (!u || !u.id) continue;
        const exists = await client.query('SELECT 1 FROM users WHERE id = $1', [u.id]);
        if (exists.rowCount) {
          await client.query(
            `UPDATE users SET name = $2, role = $3, must_change_password = $4, deleted_at = $5 WHERE id = $1`,
            [u.id, u.name || '', u.role || 'user', Boolean(u.mustChangePassword), u.deletedAt || null],
          );
        } else {
          await client.query(
            `INSERT INTO users (id, name, username, role, password_hash, must_change_password, deleted_at)
             VALUES ($1,$2,$3,$4,$5,TRUE,$6) ON CONFLICT DO NOTHING`,
            [u.id, u.name || '', u.username || u.id, u.role || 'user', hashPassword(crypto.randomBytes(16).toString('hex')), u.deletedAt || null],
          );
        }
      }
    }
    for (const p of body.projects) {
      await client.query(
        `INSERT INTO projects
          (id, name, type, subtype, entity, client_id, stage, ql_no, po_no, lead_kind, source,
           ql_status, ql_note, offer, deal_value, start_date, end_date, description,
           created_by, created_at, stage_changed_at, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, type = EXCLUDED.type, subtype = EXCLUDED.subtype,
           entity = EXCLUDED.entity, client_id = EXCLUDED.client_id, stage = EXCLUDED.stage,
           ql_no = EXCLUDED.ql_no, po_no = EXCLUDED.po_no, lead_kind = EXCLUDED.lead_kind,
           source = EXCLUDED.source, ql_status = EXCLUDED.ql_status, ql_note = EXCLUDED.ql_note,
           offer = EXCLUDED.offer, deal_value = EXCLUDED.deal_value,
           start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
           description = EXCLUDED.description, stage_changed_at = EXCLUDED.stage_changed_at,
           deleted_at = EXCLUDED.deleted_at`,
        [p.id, p.name || '', p.type || '', p.subtype || '', p.entity || '', p.clientId || null,
          p.stage || 'lead', p.qlNo || null, p.poNo || null, p.lead || 'cold', p.source || '',
          p.qlStatus || '', p.qlNote || '', Number(p.offer || 0), Number(p.dealValue || 0),
          p.start || null, p.end || null, p.desc || '', p.createdBy || null,
          p.createdAt || null, p.stageChangedAt || null, p.deletedAt || null],
      );
      await client.query('DELETE FROM project_owners WHERE project_id = $1', [p.id]);
      for (const uid of Array.isArray(p.owners) ? p.owners : []) {
        await client.query('INSERT INTO project_owners (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [p.id, uid]);
      }
      await client.query('DELETE FROM project_history WHERE project_id = $1', [p.id]);
      for (const h of Array.isArray(p.history) ? p.history : []) {
        await client.query(
          'INSERT INTO project_history (project_id, stage, at, by_user, note, ql_no) VALUES ($1,$2,$3,$4,$5,$6)',
          [p.id, h.stage || 'lead', h.at || null, h.by || null, h.note || '', h.qlNo || null],
        );
      }
      await client.query('DELETE FROM documents WHERE project_id = $1', [p.id]);
      const docs = p.docs || {};
      for (const [slot, current] of Object.entries(docs)) {
        const revs = Array.isArray(current.history) ? current.history.slice() : [];
        if (!revs.length || revs[revs.length - 1].id !== current.id) {
          revs.push({ ...current, rev: current.rev || revs.length + 1 });
        }
        for (const d of revs) {
          if (!d || !d.id) continue;
          const key = String(d.key || d.file_key || '');
          if (!key) continue; // dokumen lama belum punya objek S3; jangan simpan key palsu
          await client.query(
            `INSERT INTO documents (id, project_id, slot, rev, file_key, name, size, mime, uploaded_by, uploaded_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::timestamptz, now()))
             ON CONFLICT (id) DO UPDATE SET
               slot = EXCLUDED.slot, rev = EXCLUDED.rev, file_key = EXCLUDED.file_key,
               name = EXCLUDED.name, size = EXCLUDED.size, mime = EXCLUDED.mime`,
            [d.id, p.id, slot, Number(d.rev || 1) || 1, key, d.name || '', Number(d.size || 0), d.type || '', d.by || null, d.at || null],
          );
        }
      }
    }
    if (Array.isArray(body.audit)) {
      await client.query('DELETE FROM audit_log');
      for (const a of body.audit) {
        await client.query(
          'INSERT INTO audit_log (project_id, at, by_user, action, detail) VALUES ($1,$2,$3,$4,$5)',
          [a.projectId || null, a.at || null, a.by || null, a.action || '', a.detail || ''],
        );
      }
    }
    if (body.master) {
      await client.query(
        `INSERT INTO app_master (key, value) VALUES ('master', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(body.master)],
      );
    }
    const nextRev = await bumpRev(client);
    await client.query('COMMIT');
    return { ok: true, projects: body.projects.length, clients: body.clients.length, syncRev: nextRev };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

app.get('/health', async (request, reply) => {
  try {
    await pool.query('SELECT 1');
  } catch {
    return reply.code(503).send({ status: 'error', db: 'down' });
  }
  return { status: 'ok', db: 'ok', uptime: Math.floor(process.uptime()) };
});

app.get('/metrics', async (request, reply) => {
  reply.header('Content-Type', 'text/plain; version=0.0.4');
  return [
    '# TYPE pms_requests_total counter',
    `pms_requests_total ${metrics.requests}`,
    '# TYPE pms_errors_total counter',
    `pms_errors_total ${metrics.errors}`,
    '# TYPE pms_uptime_seconds gauge',
    `pms_uptime_seconds ${Math.floor((Date.now() - metrics.startedAt) / 1000)}`,
  ].join('\n');
});

app.post('/api/files/reconcile', { preHandler: adminPreHandler }, async (request) => {
  if (!s3) return { ok: false, message: 'S3 belum dikonfigurasi di server.' };
  const { rows } = await pool.query("SELECT file_key FROM documents WHERE file_key <> ''");
  const known = new Set(rows.map((r) => r.file_key));
  const orphans = [];
  let scanned = 0;
  let token;
  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET, ContinuationToken: token,
    }));
    for (const obj of list.Contents || []) {
      scanned += 1;
      const age = obj.LastModified ? Date.now() - new Date(obj.LastModified).getTime() : 0;
      if (!known.has(obj.Key) && age > 60 * 60 * 1000) orphans.push(obj.Key);
    }
    token = list.NextContinuationToken;
  } while (token);
  const dry = request.query?.dry === 'true';
  if (!dry) {
    for (let i = 0; i < orphans.length; i += 1000) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: S3_BUCKET,
        Delete: { Objects: orphans.slice(i, i + 1000).map((Key) => ({ Key })) },
      }));
    }
  }
  return { ok: true, dry, scanned, known: known.size, deleted: dry ? 0 : orphans.length, orphans: orphans.length, keys: orphans.slice(0, 20) };
});

app.setNotFoundHandler((request, reply) => reply.code(404).send({ message: 'Endpoint tidak ditemukan.' }));

async function start() {
  await initDb();
  await seedUsers();
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`API siap di port ${PORT}`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
