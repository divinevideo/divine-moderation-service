#!/usr/bin/env node
// Production smoke test helper for Divine Moderation Service
// Usage:
//   NOSTR_ACCESS_JWT=<jwt> node scripts/prod-smoke.mjs <sha256>

const [, , sha] = process.argv;
if (!sha) {
  console.error('Usage: node scripts/prod-smoke.mjs <sha256>');
  process.exit(1);
}

const BASE = process.env.MOD_BASE || 'https://moderation.admin.divine.video';
const JWT = process.env.CF_ACCESS_JWT_ASSERTION || process.env.NOSTR_ACCESS_JWT || '';

async function jfetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (JWT) headers['cf-access-jwt-assertion'] = JWT;
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

async function main() {
  console.log('== Self-test ==');
  const self = await jfetch('/admin/api/self-test', { headers: { 'Cf-Access-Authenticated-User-Email': 'tester@example.com' } });
  console.log(JSON.stringify(self, null, 2));

  console.log('\n== Queue action (PERMANENT_BAN) ==');
  const reqId = crypto.randomUUID();
  const queued = await jfetch('/api/v1/moderate/queue', {
    method: 'POST',
    body: JSON.stringify({ sha256: sha, action: 'PERMANENT_BAN', reason: 'prod-smoke', source: 'smoke-script', requestId: reqId })
  });
  console.log(queued);

  console.log('\n== Poll status ==');
  let status;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    status = await jfetch(`/admin/api/status/${sha}`, { headers: { 'Cf-Access-Authenticated-User-Email': 'tester@example.com' } });
    console.log(`Attempt ${i + 1}:`, status);
    if (status?.kv?.permanentBan) break;
  }

  console.log('\n== Check result ==');
  const result = await jfetch(`/check-result/${sha}`);
  console.log(result);
}

main().catch(e => { console.error(e); process.exit(1); });

