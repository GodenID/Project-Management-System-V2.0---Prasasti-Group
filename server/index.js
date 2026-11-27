'use strict';

const crypto = require('node:crypto');
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const { pool, initDb } = require('./db');

const app = Fastify({ logger: true, trustProxy: true });
app.register(cors, {
  origin: (process.env.FRONTEND_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean),
  credentials: true,
});

const PORT = Number(process.env.PORT || 3000);
const API_TOKENS = new Set((process.env.API_TOKENS || '').split(',').map((s) => s.trim()).filter(Boolean));

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

app.patch('/api/users/:id', { preHandler: adminPreHandler }, async (request, reply) => {
  const b = request.body || {};
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
