// WhatsApp lock + auth-failure reporting, against the real server.mjs.
//   node test/whatsapp-access.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { evaluateAccess } from '../lib/whatsappAccess.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : '  ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('== access rules ==');
const e = evaluateAccess;
check('no row is locked', e(null).reason === 'locked');
check('opened with 0 minutes is not usable', e({ unlocked: true }).reason === 'no_minutes');
check('minutes remaining = granted - used', e({ unlocked: true, minutes_granted: 10, minutes_used: 3.5 }).minutesRemaining === 6.5);
check('used up -> no_minutes', e({ unlocked: true, minutes_granted: 5, minutes_used: 5 }).reason === 'no_minutes');
check('re-locking blocks even with minutes left', e({ unlocked: false, minutes_granted: 50 }).allowed === false);
check('pro is unlimited', e({ plan: 'pro' }).unlimited === true && e({ plan: 'pro' }).allowed === true);
check('expired pro falls back to locked', e({ plan: 'pro', pro_until: '2020-01-01' }).reason === 'locked');
check('admin always allowed', e(null, { isAdmin: true }).allowed === true);

function startServer(port, env) {
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), WACALLS_URL: '', WACALLS_API_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  proc.stdout.on('data', (d) => logs.push(d.toString()));
  proc.stderr.on('data', (d) => logs.push(d.toString()));
  return { proc, logs };
}
const call = async (port, method, p, { token, body } = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/social-call/${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const base = 18700 + Math.floor(Math.random() * 200);
const locked = startServer(base, { NODE_ENV: 'test', LIVE_CALL_TEST_AUTH: '1', LIVE_CALL_TEST_WA_ACCESS: 'locked' });
const open5 = startServer(base + 1, { NODE_ENV: 'test', LIVE_CALL_TEST_AUTH: '1', LIVE_CALL_TEST_WA_ACCESS: 'open:5' });
const prod = startServer(base + 2, { NODE_ENV: 'production', SUPABASE_SERVICE_ROLE_KEY: '' });

try {
  await sleep(3500);
  const T = 'test-token:alice';

  console.log('== locked user ==');
  for (const p of ['wacalls/pair', 'wacalls/qr', 'whatsapp/qr']) {
    const r = await call(base, 'POST', p, { token: T });
    check(`${p} is refused with 403 whatsapp_locked`, r.status === 403 && r.json.code === 'whatsapp_locked', JSON.stringify(r));
  }
  const pp = await call(base, 'POST', 'wacalls/pair-phone', { token: T, body: { phone: '2348012345678' } });
  check('pair-phone is refused', pp.status === 403 && pp.json.code === 'whatsapp_locked');
  const placing = await call(base, 'POST', 'call', { token: T, body: { platform: 'whatsapp', target: '2348012345678', provider: 'wacalls' } });
  check('placing a WhatsApp call is refused', placing.status === 403 && placing.json.code === 'whatsapp_locked');
  check('the refusal mentions Pro and the price', /Pro/.test(placing.json.error || '') && /15,000/.test(placing.json.error || ''), placing.json.error);
  const st = await call(base, 'GET', 'status', { token: T });
  check('status still works and reports locked', st.status === 200 && st.json.access?.allowed === false && st.json.access?.reason === 'locked');
  const lo = await call(base, 'POST', 'wacalls/logout', { token: T });
  check('logout is NOT blocked by the lock', lo.status !== 403, JSON.stringify(lo));

  console.log('== user with minutes ==');
  const ok = await call(base + 1, 'GET', 'status', { token: T });
  check('status shows 5 minutes remaining', ok.json.access?.allowed === true && ok.json.access?.minutesRemaining === 5, JSON.stringify(ok.json.access));
  const pair = await call(base + 1, 'POST', 'wacalls/pair', { token: T });
  check('pairing is not refused by the lock', pair.status !== 403 || pair.json.code !== 'whatsapp_locked', JSON.stringify(pair));

  console.log('== auth failures name their cause ==');
  const none = await call(base + 2, 'GET', 'status');
  check('no token -> 401 no_token', none.status === 401 && none.json.code === 'no_token', JSON.stringify(none));
  const cfg = await call(base + 2, 'GET', 'status', { token: 'whatever' });
  check('no server key -> 503 not_configured', cfg.status === 503 && cfg.json.code === 'not_configured', JSON.stringify(cfg));
  check('not_configured says what to set', /SUPABASE_SERVICE_ROLE_KEY/.test(cfg.json.error || ''));
  check('the old catch-all sentence is gone', !/not approved yet\)/.test(cfg.json.error || ''));
} finally {
  for (const s of [locked, open5, prod]) s.proc.kill();
}
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
