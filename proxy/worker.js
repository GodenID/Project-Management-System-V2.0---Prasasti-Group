const encoder = new TextEncoder();

function base64Url(buffer) {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64DecodeUrl(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  return atob(normalized);
}

async function sign(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return base64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return new Response('ok', { status: 200 });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }
  const token = url.searchParams.get('t') || '';
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !env.DOC_PROXY_SECRET) {
    return new Response('Token wajib', { status: 403 });
  }
  const expected = await sign(payload, env.DOC_PROXY_SECRET);
  if (signature !== expected) {
    return new Response('Token tidak valid', { status: 403 });
  }
  let data;
  try { data = JSON.parse(base64DecodeUrl(payload)); } catch { return new Response('Token rusak', { status: 400 }); }
  if (!data.u || !data.e || Date.now() > Number(data.e)) {
    return new Response('Token kedaluwarsa', { status: 410 });
  }
  if (!String(data.u).startsWith('https://s3.ap-southeast-1.onidel.cloud/')) {
    return new Response('Sumber tidak diizinkan', { status: 400 });
  }
  const upstream = await fetch(data.u, { method: request.method });
  const headers = new Headers();
  for (const name of ['content-type', 'content-length', 'content-disposition', 'accept-ranges', 'etag']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Cache-Control', 'private, max-age=300');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(upstream.body, { status: upstream.status, headers });
}

export default { fetch: handle };
