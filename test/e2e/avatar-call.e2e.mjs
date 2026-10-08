// End-to-end test of an AVATAR call over WhatsApp, with no real Anam / WhatsApp / credits.
//
// What runs for real:   index.html + app.js (the actual front end) in headless Chromium,
//                       server.mjs (the actual call server), real WebRTC between the app
//                       and a simulated callee, real H.264 encode/decode of the video.
// What is simulated:    Anam's SDK (incl. its 1-concurrent-session plan limit), Supabase,
//                       the WaCalls instance, and the person being called.
//
// Setup (not saved in package.json so the host never installs a browser):
//   npm i --no-save puppeteer-core @sparticuz/chromium
// Run:    node test/e2e/avatar-call.e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FAKE_SUPABASE, FAKE_ANAM } from './fake-modules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let puppeteer, chromium;
try { puppeteer = (await import('puppeteer-core')).default; chromium = (await import('@sparticuz/chromium')).default; }
catch (e) { console.log('SKIP e2e: run `npm i --no-save puppeteer-core @sparticuz/chromium` first.'); process.exit(0); }

const APP_PORT = 5601, WA_PORT = 5602, SRV_PORT = 5603, API_KEY = 'e2e-key';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now(); const stamp = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(5) + 's';
const say = (m) => console.log(`${stamp()}  ${m}`);

// ----------------------------------------------------------------------------- static server
const CALLEE_HTML = `<!doctype html><meta charset=utf-8><body><canvas id=c width=64 height=64></canvas><script>
const S = window.stats = { firstLoudAt: 0, channels: [], t0: 0, tFirstMsg: 0, tFirstKey: 0, keyTimes: [], videoBytes: 0, lastMsgAt: 0, maxGapMs: 0, videoMsgs: 0, keyMsgs: 0, decoded: 0, bright: 0, dark: 0, lastRGB: null, pcmBytes: 0, pcmLoud: 0, errors: [] };
let dec = null, gotKey = false; const ctx = document.getElementById('c').getContext('2d', { willReadFrequently: true });
function mkDecoder(){ dec = new VideoDecoder({ output: (f) => { ctx.drawImage(f, 0, 0, 64, 64); f.close(); const d = ctx.getImageData(0,0,64,64).data; const cs=[[1,1],[62,1],[1,62],[62,62]].map(([x,y])=>{const i=(y*64+x)*4;return (d[i]+d[i+1]+d[i+2])/3}); S.corners = cs.map(Math.round); if (cs.every((v)=>v>25)) S.edgeOk=(S.edgeOk||0)+1; else S.edgeBad=(S.edgeBad||0)+1;
let r=0,g=0,b=0,n=d.length/4; for(let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2]} r/=n;g/=n;b/=n; S.decoded++; S.lastRGB=[r|0,g|0,b|0]; ((r+g+b)/3>25?S.bright++:S.dark++); }, error: (e) => S.errors.push(String(e) + ' @msg' + S.videoMsgs + ' lastKey=' + window.lastKey + ' lastLen=' + window.lastLen) }); dec.configure({ codec: 'avc1.42E01F', optimizeForLatency: true }); }
function onVideo(buf){ const b = new Uint8Array(buf); if (b.length < 6) return; const now = performance.now(); if (!S.tFirstMsg) S.tFirstMsg = now; if (S.lastMsgAt) S.maxGapMs = Math.max(S.maxGapMs, now - S.lastMsgAt); S.lastMsgAt = now; S.videoBytes += b.length; S.videoMsgs++; const key = (b[0] & 1) === 1; window.lastKey = key; window.lastLen = b.length; if (S.videoMsgs <= 2) S.first = (S.first || []).concat([[key, b.length, Array.from(b.subarray(5, 20)).map((x) => x.toString(16)).join(' ')]]); if (key) { S.keyMsgs++; gotKey = true; S.keyTimes.push(Math.round(now)); if (!S.tFirstKey) S.tFirstKey = now; } if (!gotKey) return; if (!dec || dec.state === 'closed') mkDecoder();
  try { dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ((b[1]<<24)|(b[2]<<16)|(b[3]<<8)|b[4])*1000, data: b.subarray(5) })); } catch (e) { S.errors.push(String(e)); } }
function onPcm(buf){ S.pcmBytes += buf.byteLength; const v = new Int16Array(buf.slice(0, buf.byteLength & ~1)); let s=0; for (let i=0;i<v.length;i++) s+=v[i]*v[i]; const rms = Math.sqrt(s/Math.max(1,v.length)); if (rms > 300) { S.pcmLoud++; if (!S.firstLoudAt) S.firstLoudAt = Date.now(); } }
window.answerOffer = async (sdp) => {
  const pc = new RTCPeerConnection({ iceServers: [] }); window.pc = pc;
  pc.ondatachannel = (e) => { const dc = e.channel; dc.binaryType = 'arraybuffer'; S.channels.push(dc.label);
    if (dc.label === 'vp8') { dc.onopen = () => { S.t0 = performance.now(); dc.send(new Uint8Array([1])); }; dc.onmessage = (m) => onVideo(m.data); }
    if (dc.label === 'pcm') dc.onmessage = (m) => onPcm(m.data); };
  await pc.setRemoteDescription({ type: 'offer', sdp });
  const a = await pc.createAnswer(); await pc.setLocalDescription(a);
  await new Promise((res) => { if (pc.iceGatheringState === 'complete') return res(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && res(); setTimeout(res, 3000); });
  return pc.localDescription.sdp;
};
window.hangupCallee = () => { try { window.pc.close(); } catch (e) {} };
</script>`;
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const staticSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__callee.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(CALLEE_HTML); }
  const f = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});

// ----------------------------------------------------------------------------- WaCalls stand-in
let calleePage = null;
const wa = { calls: [], events: [], cfg: {}, hangups: 0, reqs: [] };
function waEmit(type, extra = {}) { wa.events.push(`data: ${JSON.stringify({ type, at: Date.now(), sessionId: 's1', ...extra })}\n\n`); }
const jsonOut = (res, code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
const waSrv = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  let body = {}; if (req.method === 'POST') { let raw = ''; for await (const c of req) raw += c; try { body = raw ? JSON.parse(raw) : {}; } catch (e) {} }
  wa.reqs.push(`${req.method} ${p}`);
  if (req.headers['x-api-key'] !== API_KEY) return jsonOut(res, 401, { error: 'bad key' });
  const sess = [{ id: 's1', name: 'u:alice', jid: '2348012345678:12@s.whatsapp.net', state: 'open', paired: true }];
  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ type: 'session-list', sessions: sess })}\n\n`);
    const t = setInterval(() => { const n = wa.events.shift(); if (n) try { res.write(n); } catch (e) {} }, 20); req.on('close', () => clearInterval(t)); return;
  }
  if (p === '/api/sessions') return jsonOut(res, 200, { sessions: sess });
  if (/\/calls$/.test(p) && req.method === 'GET') return jsonOut(res, 200, { active: wa.calls.filter((c) => !c.ended).length, maxCallsPerSession: 8 });
  if (/\/calls$/.test(p) && req.method === 'POST') {
    const c = { id: 'call-' + (wa.calls.length + 1), ended: false, state: 'ringing', phone: body.phone }; wa.callPostAt = Date.now();
    wa.calls.push(c); const cfg = wa.cfg;
    setTimeout(() => waEmit('call-status', { id: c.id, status: 'ringing', media: 'video', direction: 'outbound' }), 300);
    if (cfg.declineAfterMs) setTimeout(() => { if (c.ended) return; c.ended = true; waEmit('call-ended', { id: c.id, reason: 'declined' }); }, cfg.declineAfterMs);
    if (cfg.answerAfterMs !== null && !cfg.declineAfterMs) setTimeout(() => { if (c.ended) return; c.state = 'active'; wa.connectedAt = Date.now(); waEmit('call-status', { id: c.id, status: 'connected', media: 'video', direction: 'outbound' }); }, cfg.answerAfterMs ?? 2500);
    return jsonOut(res, 200, { call: { callId: c.id } });
  }
  const m = p.match(/\/calls\/([^/]+)(\/.*)?$/);
  if (m) {
    const c = wa.calls.find((x) => x.id === m[1]); const tail = m[2] || '';
    if (!tail && req.method === 'GET') return c ? jsonOut(res, 200, { id: c.id, sid: 's1', state: c.ended ? 'ended' : c.state, direction: 'outbound' }) : jsonOut(res, 404, { error: 'no such call' });
    if (!tail && req.method === 'DELETE') { if (c) { c.ended = true; wa.hangups++; waEmit('call-ended', { id: c.id, reason: 'user_ended' }); } res.writeHead(204); return res.end(); }
    if (tail === '/webrtc') {
      try { const sdp = await calleePage.evaluate((o) => window.answerOffer(o), body.sdp_offer); return jsonOut(res, 200, { sdp_answer: sdp }); }
      catch (e) { return jsonOut(res, 500, { error: 'callee page gone: ' + String(e).slice(0, 80) }); } // call ended while negotiating
    }
    return jsonOut(res, 200, { status: 'ok' });
  }
  jsonOut(res, 404, { error: 'unhandled ' + p });
});

// ----------------------------------------------------------------------------- the phone (app page)
function startServer() {
  const proc = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(SRV_PORT), NODE_ENV: 'test', LIVE_CALL_TEST_AUTH: '1', LIVE_CALL_TEST_WA_ACCESS: 'pro',
      WACALLS_URL: `http://127.0.0.1:${WA_PORT}`, WACALLS_API_KEY: API_KEY, WACALLS_CLIENT_ID: 'e2e' } });
  const logs = []; proc.stdout.on('data', (d) => logs.push(String(d))); proc.stderr.on('data', (d) => logs.push(String(d)));
  return { proc, logs };
}

async function runScenario(browser, name, { anam = {}, wacalls = {}, endMode = 'user', holdMs = 12000, avcc = false, testMode = false } = {}) {
  console.log(`\n=== ${name}`);
  wa.calls = []; wa.events = []; wa.hangups = 0; wa.cfg = wacalls; wa.callPostAt = 0; wa.connectedAt = 0;
  calleePage = await browser.newPage(); await calleePage.goto(`http://127.0.0.1:${APP_PORT}/__callee.html`);
  const page = await browser.newPage(); await page.setBypassServiceWorker(true);
  const R = { summaryPosts: [], pageErrors: [], consoleErrors: [], stopActive: 0, anamPosts: [], mic: 0 };
  page.on('pageerror', (e) => R.pageErrors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'error') R.consoleErrors.push(t.slice(0, 200)); if (process.env.E2E_VERBOSE) console.log('   [page]', t.slice(0, 200)); });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  try { const cdp = await page.createCDPSession(); await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34, left: 0, right: 0 } }); } catch (e) { /* older Chromium: no safe-area emulation */ }
  await page.evaluateOnNewDocument((anamCfg) => {
    window.__anamCfg = { limit: 1, startDelayMs: 1200, releaseLagMs: 0, failAttempts: [], ...anamCfg };
    const RealWS = window.WebSocket;
    window.__wslog = [];
    window.WebSocket = function (url, p) { const w = new RealWS(String(url).replace(/^wss?:\/\/live-call-tbbk\.onrender\.com/, 'ws://127.0.0.1:5603'), p); w.addEventListener('message', (e) => { if (typeof e.data === 'string') window.__wslog.push(e.data.slice(0, 170)); }); return w; };
    window.WebSocket.prototype = RealWS.prototype; Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__gum = 0; navigator.mediaDevices.getUserMedia = (c) => { window.__gum++; return gum(c); };
  }, anam);
  if (avcc) await page.evaluateOnNewDocument(() => { const c = VideoEncoder.prototype.configure; VideoEncoder.prototype.configure = function (cfg) { const x = { ...cfg }; delete x.avc; return c.call(this, x); }; });
  if (testMode) await page.evaluateOnNewDocument(() => { try { localStorage.setItem('lc_test_avatar', '1'); } catch (e) {} });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const u = new URL(req.url()); const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    try {
      if (u.hostname === 'esm.sh') {
        if (u.pathname.includes('supabase')) return req.respond({ status: 200, contentType: 'application/javascript', headers: cors, body: FAKE_SUPABASE });
        if (u.pathname.includes('anam')) return req.respond({ status: 200, contentType: 'application/javascript', headers: cors, body: FAKE_ANAM });
        return req.respond({ status: 200, contentType: 'application/javascript', headers: cors, body: 'export {}' });
      }
      if (u.hostname === 'live-call-tbbk.onrender.com') return req.continue({ url: `http://127.0.0.1:${SRV_PORT}${u.pathname}${u.search}` });
      if (u.hostname === 'wacalls.onrender.com') return req.respond({ status: 200, headers: cors, body: 'ok' });
      if (u.origin === `http://127.0.0.1:${APP_PORT}` && u.pathname.startsWith('/api/')) {
        const body = req.postData() ? JSON.parse(req.postData()) : {};
        let out = {};
        if (u.pathname === '/api/keys') out = { anam: true, fal: true, decart: true };
        else if (u.pathname === '/api/anam') {
          if (u.searchParams.get('resource') === 'avatars') out = { avatars: [{ id: 'av1', name: 'Test avatar' }] };
          else if (u.searchParams.get('resource') === 'voices') out = { voices: [{ id: 'v1', name: 'Test voice' }] };
          else if (u.searchParams.get('type')) out = { id: 'av1', name: 'Test avatar', imageUrl: '' };
          else if (body.action === 'stop-active') { R.stopActive++; if (anam.stubborn && R.stopActive === 1) out = { found: 0, stopped: 0 }; else { const n = await page.evaluate(() => window.__anamReleaseAll()); out = { found: n, stopped: n }; } }
          else if (body.action === 'stop') out = { ok: true };
          else { R.anamPosts.push(body.action || 'session'); out = { sessionToken: 'tok-' + R.anamPosts.length }; }
        } else if (u.pathname === '/api/call-summary') { R.summaryPosts.push(body); out = { summary: 'ok' }; }
        return req.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(out) });
      }
      if (u.origin === `http://127.0.0.1:${APP_PORT}`) return req.continue();
      return req.respond({ status: 200, headers: cors, body: '' }); // fonts, analytics, etc.
    } catch (e) { try { req.abort(); } catch (_) {} }
  });

  await page.goto(`http://127.0.0.1:${APP_PORT}/index.html`);
  await page.waitForFunction(() => document.getElementById('screenHome')?.offsetHeight > 0, { timeout: 15000 });
  say('app loaded and signed in');
  if (process.env.E2E_HOME_SHOT) { await sleep(5000); await page.screenshot({ path: process.env.E2E_HOME_SHOT }); }
  // contacts tab -> tap the saved contact -> avatar source -> place call
  await page.evaluate(() => [...document.querySelectorAll('.tabBtn[data-tab="contacts"]')].find((b) => b.offsetParent)?.click());
  await page.waitForSelector('#contactsTabList .contactRow', { timeout: 8000 });
  await page.evaluate(() => document.querySelector('#contactsTabList .contactRow').click());
  try { await page.waitForFunction(() => document.getElementById('prepSourceAvatarBtn')?.offsetParent, { timeout: 8000 }); }
  catch (e) {
    await page.screenshot({ path: '/tmp/e2e-fail.png' });
    console.log('prep screen never appeared. visible text:', (await page.evaluate(() => [...document.querySelectorAll('.subScreen.active, .screen.active, #authScreen:not(.hidden)')].map((n) => n.id + ': ' + n.innerText.slice(0, 200).replace(/\n+/g, ' | ')).join('\n'))));
    console.log('callPrepModal:', await page.evaluate(() => { const m = document.getElementById('callPrepModal'); const b = document.getElementById('prepSourceAvatarBtn'); return JSON.stringify({ cls: m && m.className, btnParent: !!(b && b.offsetParent), btnDisplay: b && getComputedStyle(b).display, modalDisplay: m && getComputedStyle(m).display, vis: m && getComputedStyle(m).visibility }); }));
    console.log('page errors:', R.pageErrors, 'console errors:', R.consoleErrors.slice(0, 5));
    throw e;
  }
  await page.evaluate(() => document.getElementById('prepSourceAvatarBtn').click());
  await sleep(300);
  const t0 = Date.now(); await page.evaluate(() => document.getElementById('prepStartCallActionBtn').click()); say('Place Call tapped');

  // sample the call for holdMs
  const timeline = []; let last = '';
  const status = () => page.evaluate(() => ({
    screen: document.getElementById('socialCallScreen')?.classList.contains('active') || false,
    label: document.getElementById('socialCallStatusLabel')?.textContent || '',
    prepErr: document.getElementById('prepErrorHint')?.textContent || '',
    toast: document.getElementById('callEndToast')?.style.display === 'block' ? document.getElementById('callEndToast').innerText.slice(0, 400) : '',
  }));
  let answeredAt = null, endedAt = null, layout = null;
  while (Date.now() - t0 < holdMs + 20000) {
    const s = await status().catch(() => null); if (!s) break;
    const line = `${s.screen ? 'CALL' : 'prep'} | ${s.label || s.prepErr}`.slice(0, 150);
    if (line !== last) { say('ui: ' + line); last = line; timeline.push([Date.now() - t0, line]); }
    if (s.screen && /connected/i.test(s.label) && !answeredAt) answeredAt = Date.now();
    if (!s.screen && timeline.length > 1 && Date.now() - t0 > 2000 && !endedAt) { endedAt = Date.now(); break; }
    if (answeredAt && !layout && Date.now() - answeredAt > 4000) {
      layout = await page.evaluate(() => {
        const r = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), display: cs.display, fit: cs.objectFit, z: cs.zIndex }; };
        return { vw: innerWidth, vh: innerHeight, screen: r('socialCallScreen'), remote: r('socialRemoteVideo'), self: r('socialSelfVideo'), peer: r('socialPeerCanvas'), top: r('socialCallTop'), bottom: r('socialCallBottom'), cls: { remote: document.getElementById('socialRemoteVideo').className, self: document.getElementById('socialSelfVideo').className, screenAttr: document.getElementById('socialCallScreen').dataset.layout } };
      });
      if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
    }
    if (answeredAt && Date.now() - answeredAt > holdMs) break;
    await sleep(250);
  }
  const survived = !endedAt;
  const safe = async (label, fn, dflt) => { try { return await fn(); } catch (e) { console.log(`   (harness: ${label} failed: ${String(e).slice(0, 90)})`); return dflt; } };
  const callee = await safe('callee stats', () => calleePage.evaluate(() => ({ ...window.stats })), { channels: [], videoMsgs: 0, decoded: 0, bright: 0, dark: 0, lastRGB: null, pcmBytes: 0, pcmLoud: 0 });
  const anamLog = await safe('anam log', () => page.evaluate(() => ({ ...window.__anamLog, attempts: window.__anamLog.attempts.map((a) => ({ n: a.n, t: a.t, userAudio: a.userAudio })) })), { attempts: [], maxLive: 0, rejected: 0, live: -1 });
  const gum = await safe('gum', () => page.evaluate(() => window.__gum), -1);
  const finalUi = await status().catch(() => ({}));
  let toastAfter = '';
  if (survived && finalUi.screen) {
    if (endMode === 'remote') { waEmit('call-ended', { id: 'call-1', reason: 'remote_ended' }); }
    else { await page.evaluate(() => document.getElementById('socialEndBtn').click()); }
    for (let i = 0; i < 40; i++) { await sleep(250); const s2 = await status().catch(() => ({})); if (!s2.screen) { toastAfter = s2.toast || ''; break; } }
    await sleep(3000); // give any cleanup time to finish
  }
  const liveAfter = await page.evaluate(() => window.__anamLog.live).catch(() => -1);
  if (process.env.E2E_VERBOSE) console.log('   ws messages:', (await page.evaluate(() => window.__wslog.slice(-8))).join('\n      '));
  if (process.env.E2E_VERBOSE) console.log('   toast dom:', await page.evaluate(() => { const t = document.getElementById('callEndToast'); return t ? t.style.display + ' | ' + t.innerText.slice(0, 120).replace(/\n/g, ' / ') : 'none'; }));
  const calls = wa.calls.length;
  const res = { name, layout, liveAfter, connectedAt: wa.connectedAt, callPostAt: wa.callPostAt, toastAfter, survived, answered: !!answeredAt, callee, anamLog, gum, calls, summaryPosts: R.summaryPosts, pageErrors: R.pageErrors, finalUi, timeline, callsPlaced: calls, stopActive: R.stopActive };
  await page.close(); await calleePage.close();
  return res;
}

// ----------------------------------------------------------------------------- assertions
let failed = 0;
const check = (ok, what, extra = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && extra ? '  -> ' + extra : ''}`); if (!ok) failed++; };
function report(r) {
  const c = r.callee; const spanS = c.lastMsgAt && c.tFirstMsg ? (c.lastMsgAt - c.tFirstMsg) / 1000 : 0;
  const gaps = c.keyTimes.slice(1).map((t, i) => Math.round((t - c.keyTimes[i]) / 100) / 10);
  if (spanS > 0) console.log(`  video: first msg ${Math.round(c.tFirstMsg - c.t0)}ms after channel open, first keyframe ${c.tFirstKey ? Math.round(c.tFirstKey - c.t0) + 'ms' : 'NEVER'}, ${c.keyMsgs} keyframe(s) in ${spanS.toFixed(1)}s (gaps ${JSON.stringify(gaps)}s), ${(c.videoMsgs / spanS).toFixed(1)} fps, ${((c.videoBytes * 8) / spanS / 1000).toFixed(0)} kbps, longest silence ${Math.round(c.maxGapMs)}ms`);
  console.log(`  callee got: ${r.callee.videoMsgs} video msgs, ${r.callee.decoded} decoded (${r.callee.bright} bright / ${r.callee.dark} dark), last RGB ${JSON.stringify(r.callee.lastRGB)}, ${r.callee.pcmBytes} audio bytes (${r.callee.pcmLoud} loud chunks)`);
  console.log(`  anam: ${r.anamLog.attempts.length} attempt(s), max ${r.anamLog.maxLive} live at once, ${r.anamLog.rejected} rejected; mic requests: ${r.gum}; calls placed: ${r.calls}`);
}

process.on('unhandledRejection', (e) => { if (process.env.E2E_VERBOSE) console.log('   (harness: ignored late rejection:', String(e).slice(0, 80) + ')'); });
const srv = startServer();
await new Promise((r) => staticSrv.listen(APP_PORT, '127.0.0.1', r));
await new Promise((r) => waSrv.listen(WA_PORT, '127.0.0.1', r));
await sleep(1500);
const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), headless: 'shell',
  args: [...chromium.args.filter((a) => !/single-process|no-zygote/.test(a)), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns', '--no-sandbox', '--allow-loopback-in-peer-connection'] });

// ---- the logo must always show: normally, and via the icon fallback when logo.png fails to load ----
async function logoCheck(browser, blockLogo) {
  const page = await browser.newPage(); await page.setBypassServiceWorker(true); await page.setViewport({ width: 390, height: 844 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.hostname === 'esm.sh') return req.respond({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: u.pathname.includes('supabase') ? FAKE_SUPABASE : u.pathname.includes('anam') ? FAKE_ANAM : 'export {}' });
    if (u.origin === `http://127.0.0.1:${APP_PORT}` && u.pathname === '/logo.png' && blockLogo) return req.abort();
    if (u.origin === `http://127.0.0.1:${APP_PORT}` && u.pathname.startsWith('/api/')) return req.respond({ status: 200, contentType: 'application/json', body: '{}' });
    if (u.origin === `http://127.0.0.1:${APP_PORT}`) return req.continue();
    return req.respond({ status: 200, body: '' });
  });
  await page.goto(`http://127.0.0.1:${APP_PORT}/index.html`);
  await sleep(2500);
  const imgs = await page.evaluate(() => [...document.querySelectorAll('img')].filter((i) => /logo|icon-192/.test(i.getAttribute('src') || '')).map((i) => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0 })));
  await page.close(); return imgs;
}
const only = process.argv[2];
const scenarios = {
  happy: ['S1 happy path: avatar starts first try, callee answers', {}],
  limit1: ['S2 stubborn leak: the cleanup does not free the session at first, the first attempt is refused, then it recovers', { anam: { preLive: 1, stubborn: true } }],
  preflight: ['S2b a leaked Anam session is cleared BEFORE the first attempt (no refused attempt at all)', { anam: { preLive: 1 } }],
  avcc: ['S7 the browser encoder outputs AVCC instead of Annex-B (as Safari may): the callee must still get decodable video', { avcc: true, holdMs: 8000 }],
  testmode: ['S8 free test mode: no Anam at all, callee still sees a picture and hears the beep', { testMode: true, holdMs: 9000 }],
  remote: ['S5 callee hangs up mid-call', { endMode: 'remote', holdMs: 6000 }],
  declined: ['S6 callee declines the call', { wacalls: { declineAfterMs: 2500 }, holdMs: 3000 }],
  dead: ['S3 Anam is unavailable (every attempt fails)', { anam: { failAttempts: [1, 2, 3, 4, 5, 6] } }],
  slow: ['S4 avatar takes 25s to start; callee answers in 3s', { anam: { startDelayMs: 25000 }, wacalls: { answerAfterMs: 3000 }, holdMs: 8000 }],
};
const all = {};
try {
  if (!only || only === 'logo') {
    console.log('\n=== S9 logo images always show');
    const normal = await logoCheck(browser, false); const blocked = await logoCheck(browser, true);
    check(normal.length > 0 && normal.every((i) => i.ok), 'every logo image loads normally', JSON.stringify(normal.filter((i) => !i.ok)));
    check(blocked.length > 0 && blocked.every((i) => i.ok), 'if logo.png fails, the icon fallback shows instead of a broken-image box', JSON.stringify(blocked.filter((i) => !i.ok)));
  }
  if (only === 'logo') { /* only this one */ }
  for (const [key, [title, opts]] of Object.entries(scenarios)) {
    if (only && only !== key) continue; if (only === 'logo') continue;
    if (opts.anam?.preLive) { /* handled below via init script */ }
    const r = await runScenario(browser, title, opts); all[key] = r; report(r);
    if (key === 'happy') {
      check(r.survived, 'call stays up (no self hang-up)');
      check(r.callee.channels.includes('vp8') && r.callee.channels.includes('pcm'), 'callee side has media channels', JSON.stringify(r.callee.channels));
      check(r.callee.decoded > 10, 'callee decoded video frames', String(r.callee.decoded));
      check(r.callee.bright > r.callee.dark && r.callee.bright > 5, 'callee video is the avatar, not blank/black', JSON.stringify(r.callee.lastRGB));
      check(r.callee.pcmLoud > 5, 'callee hears the avatar voice (not silence)', `${r.callee.pcmLoud} loud of ${r.callee.pcmBytes} bytes`);
      check(r.gum === 0, 'device microphone/camera never requested in an avatar call', String(r.gum));
      check(r.anamLog.maxLive === 1 && r.anamLog.attempts.length === 1, 'exactly one Anam session for the call', JSON.stringify(r.anamLog));
      check(r.anamLog.attempts[0]?.userAudio === true, 'avatar listens to the callee audio stream, not the mic');
      check(r.summaryPosts.length === 1, 'one call summary requested after the call', String(r.summaryPosts.length));
      check(r.summaryPosts[0]?.platform === 'whatsapp' && r.summaryPosts[0]?.answered === true && r.summaryPosts[0]?.callee === 'Callee Chris' && r.summaryPosts[0]?.durationSec > 3, 'summary request says: WhatsApp, answered, who, how long', JSON.stringify({ ...r.summaryPosts[0], transcript: '...' }));
      check(r.summaryPosts[0]?.transcript?.length >= 2, 'summary request carries the transcript', JSON.stringify(r.summaryPosts[0] || {}).slice(0, 200));
      check(wa.hangups >= 1, 'WhatsApp call was hung up on End');
      const a1 = r.anamLog.attempts[0];
      check(a1 && r.callPostAt && a1.t < r.callPostAt, 'the avatar started BEFORE the call was dialled', `avatar ${a1 && a1.t}, dial ${r.callPostAt}`);
      const firstMute = r.anamLog.muteLog?.[0], unmute = r.anamLog.muteLog?.find((m) => !m.m), msg = r.anamLog.msgs?.[0];
      check(firstMute && firstMute.m && firstMute.t < r.connectedAt, 'avatar input muted before the call connected', JSON.stringify(r.anamLog.muteLog));
      check(unmute && unmute.t >= r.connectedAt + 4500 && unmute.t <= r.connectedAt + 8500, 'avatar unmuted ~5s after connect', unmute ? String(unmute.t - r.connectedAt) + 'ms' : 'never');
      check(msg && /\[CALL EVENT\]/.test(msg.msg) && /connected/.test(msg.msg) && msg.t >= r.connectedAt + 4500, 'avatar told the call is connected, not before +5s', msg ? msg.msg + ' @+' + (msg.t - r.connectedAt) + 'ms' : 'never');
      check(r.callee.firstLoudAt && r.callee.firstLoudAt >= r.connectedAt + 4500, 'callee hears nothing from the avatar before +5s', r.callee.firstLoudAt ? 'first sound @+' + (r.callee.firstLoudAt - r.connectedAt) + 'ms' : 'never heard');
      check(r.callee.edge === undefined || r.callee.edge, 'callee picture reaches all four edges (no black bars)', JSON.stringify(r.callee.corners));
      check(r.liveAfter === 0, 'Anam session is released after pressing End (no leak)', 'still live: ' + r.liveAfter);
    }
    if (key === 'preflight') {
      check(r.anamLog.rejected === 0 && r.anamLog.attempts.length === 1, 'first attempt succeeds: nothing refused, one attempt', JSON.stringify({ rejected: r.anamLog.rejected, attempts: r.anamLog.attempts.length }));
      check(r.stopActive >= 1, 'leftover sessions were cleared before starting');
      check(r.survived && r.callee.bright > 5, 'call connects and the callee sees the avatar');
    }
    if (key === 'avcc') {
      check(r.callee.decoded > 10 && r.callee.bright > r.callee.dark, 'AVCC encoder output was converted: callee decodes real picture', `decoded=${r.callee.decoded} bright=${r.callee.bright} dark=${r.callee.dark} errors=${JSON.stringify(r.callee.errors)}`);
      check(r.callee.errors.length === 0, 'no decode errors on the callee');
    }
    if (key === 'testmode') {
      check(r.anamLog.attempts.length === 0, 'no Anam session was used', JSON.stringify(r.anamLog.attempts));
      check(r.callee.bright > 10 && r.callee.pcmLoud > 3, 'callee sees the test card and hears the beep', `bright=${r.callee.bright} loud=${r.callee.pcmLoud}`);
      check(r.survived, 'test call stays up');
    }
    if (key === 'limit1') {
      check(r.anamLog.rejected >= 1, 'scenario really hit the Anam concurrency limit', JSON.stringify(r.anamLog));
      check(r.survived && r.answered, 'call still connects after the first avatar attempt is refused', `survived=${r.survived} answered=${r.answered}`);
      check(r.callee.bright > 5, 'callee ends up seeing the avatar', JSON.stringify(r.callee.lastRGB));
      check(r.anamLog.maxLive <= 1, 'never more than one Anam session at once');
    }
    if (key === 'remote') {
      check(r.liveAfter === 0, 'Anam session is released when the callee hangs up (no leak)', 'still live: ' + r.liveAfter);
      check(/hung up|ended/i.test(r.toastAfter), 'screen says why the call ended', JSON.stringify(r.toastAfter).slice(0, 200));
      check(r.summaryPosts.length === 1 && r.summaryPosts[0].answered === true, 'a summary is requested when the callee hangs up', String(r.summaryPosts.length));
    }
    if (key === 'declined') {
      check(r.summaryPosts.length === 1 && r.summaryPosts[0].answered === false, 'a "did not pick up" summary is requested', JSON.stringify(r.summaryPosts).slice(0, 200));
      check(r.liveAfter === 0, 'Anam session released after a declined call (no leak)', 'still live: ' + r.liveAfter);
    }
    if (key === 'dead') {
      check(r.callsPlaced === 0, 'nothing is dialled when the avatar cannot start', `calls placed: ${r.callsPlaced}`);
      check(/anam|avatar/i.test(r.finalUi.prepErr || ''), 'the reason is shown on screen', JSON.stringify(r.finalUi));
    }
    if (key === 'slow') {
      check(r.callsPlaced === 1, 'the phone still rings while the avatar is slow');
      check(r.survived, 'call is not hung up while the avatar is still starting');
      check(r.liveAfter === 0, 'Anam session is released at the end (no leak)', 'still live: ' + r.liveAfter);
      check(r.callee.decoded > 5, 'callee gets video (placeholder, then avatar)', String(r.callee.decoded));
    }
  }
} finally {
  await browser.close(); srv.proc.kill(); staticSrv.close(); waSrv.close();
}
fs.writeFileSync('/tmp/e2e-result.json', JSON.stringify(all, null, 1));
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall e2e checks passed');
process.exit(failed ? 1 : 0);
