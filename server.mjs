import http from 'http';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execFileSync } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import * as greenApi from './server/greenapi_bridge.mjs';
import { getServiceClient, getAuthedUserId } from './lib/supabaseAdmin.js';
import { evaluateAccess, ACCESS_MESSAGES } from './lib/whatsappAccess.js';
import { getProviderKey } from './lib/keys.js';
import { voiceChanger, startVoiceChangerProcess, VC_CONFIG } from './server/voice_changer.mjs';
import { wacalls, isConfigured as wacallsConfigured, userContext, currentUserId } from './server/wacalls.mjs';

// ---------------------------------------------------------------------
// WhatsApp backends. There are exactly TWO and they never touch each other:
//
//   1. GREEN-API  - server/greenapi_bridge.mjs (REST) + the Green API calls
//      SDK in the browser. Per-user credentials from Supabase Vault. This is
//      the original integration and it is UNCHANGED: every /whatsapp/* route
//      below still resolves the caller's own Green API credentials, and
//      /api/social-call/call still defaults to it for platform=whatsapp.
//
//   2. WaCalls - server/wacalls.mjs talking to an external WaCalls instance
//      (a real WhatsApp client: session, pairing, 1:1 calls and VIDEO calls,
//      carried over its own VoIP/WebRTC stack). The live Anam / Lucy 2.5
//      avatar output is what WaCalls sends as the call's outgoing video, via
//      the browser leg: the page pushes JPEG-free encoded frames over WaCalls'
//      "vp8" data channel and mic PCM over its "pcm" data channel, while the
//      peer's audio/video come back on those same channels. Green API has no
//      video calling at all (its SDK is audio-only), so WaCalls is the only
//      engine that can carry video.
//
// Selection is explicit: the frontend sends `provider` on the call request
// and hits the /wacalls/* routes only when the user chose that engine.
// Nothing here silently switches a Green API user onto WaCalls, and WaCalls
// neither reads nor needs Green API credentials.
// ---------------------------------------------------------------------
export const WHATSAPP_PROVIDERS = ['greenapi', 'wacalls'];


// Resolves the AUTHENTICATED CALLER's own Green API credentials - every
// user brings their own Green API account (their own WhatsApp number),
// stored encrypted via the same Supabase Vault mechanism already used for
// Anam/fal keys. There is no shared/global WhatsApp connection for the
// whole app; each user's WhatsApp calling is entirely their own.
async function requireGreenApiCreds(req) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) throw new Error('Not signed in');
  const raw = await getProviderKey(supabase, userId, 'greenapi');
  if (!raw) throw new Error('Add your Green API credentials in Profile settings first');
  const creds = greenApi.parseCreds(raw);
  if (!creds) throw new Error('Saved Green API credentials are malformed - re-save as idInstance:apiTokenInstance');
  return creds;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const TG_PORT = parseInt(process.env.TG_PORT || '5050', 10);
const TGCALLS_PORT = parseInt(process.env.TGCALLS_PORT || '5051', 10);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Social call history in-memory + persisted cache
const CALL_HISTORY_FILE = path.join(__dirname, 'data', 'social_call_history.json');
let callHistory = [];
try {
  if (fs.existsSync(CALL_HISTORY_FILE)) {
    callHistory = JSON.parse(fs.readFileSync(CALL_HISTORY_FILE, 'utf8'));
  }
} catch (e) {
  callHistory = [];
}

function saveCallHistory(record) {
  try { clearCallLimit(); chargeWhatsappMinutes(record); } catch (e) {}
  callHistory.unshift(record);
  if (callHistory.length > 100) callHistory.pop();
  try {
    fs.mkdirSync(path.dirname(CALL_HISTORY_FILE), { recursive: true });
    fs.writeFileSync(CALL_HISTORY_FILE, JSON.stringify(callHistory, null, 2));
  } catch (e) {}
}

// Active social call state
// Active social call, PER USER. Every request / socket / event handler runs
// inside userContext (see below), and `activeCall.v` reads and writes the call
// of whoever is in that context - so two people can be on calls at once and
// never see or end each other's.
const callsByUser = new Map();
const activeCall = {
  get v() { return callsByUser.get(currentUserId() || '_none') || null; },
  set v(call) {
    const k = currentUserId() || '_none';
    if (call) callsByUser.set(k, call); else callsByUser.delete(k);
  },
};

// Signed-in AND approved. Same approval flag the app's login gate uses, now
// enforced on the server too, so an unapproved account cannot place calls by
// talking to the API directly.
//
// Every way this can fail has its own reason, logged here and sent to the
// page, because they need different fixes and one catch-all sentence ("not
// signed in or not approved") hid which one was happening:
//   no_token        the page sent no login token
//   bad_token       the token is expired / not valid for this project
//   not_configured  this server has no SUPABASE_SERVICE_ROLE_KEY
//   not_approved    signed in fine, but no approved row in user_approvals
//   check_failed    Supabase could not be reached / errored
const approvalCache = new Map();
const AUTH_FAILURES = {
  no_token:       { status: 401, error: 'Your login token was not sent. Sign out and sign in again.' },
  bad_token:      { status: 401, error: 'Your session expired. Sign out and sign in again.' },
  not_configured: { status: 503, error: 'This server cannot verify accounts: SUPABASE_SERVICE_ROLE_KEY is not set on it.' },
  not_approved:   { status: 403, error: 'Your account is not approved yet.' },
  check_failed:   { status: 503, error: 'Could not verify your account right now. Try again in a moment.' },
};
async function authCheck(token) {
  if (!token) return { reason: 'no_token' };
  // Test harness only (never set in production): "test-token:<user>" is user <user>.
  if (process.env.NODE_ENV === 'test' && process.env.LIVE_CALL_TEST_AUTH === '1' && token.startsWith('test-token:')) {
    const u = token.slice('test-token:'.length);
    return u ? { userId: u, email: null, reason: null } : { reason: 'bad_token' };
  }
  let supabase;
  try { supabase = getServiceClient(); }
  catch (e) { console.error('[auth] ' + e.message); return { reason: 'not_configured' }; }
  let user = null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return { reason: 'bad_token' };
    user = data.user;
  } catch (e) {
    console.error('[auth] token check failed: ' + e.message);
    return { reason: 'check_failed' };
  }
  const hit = approvalCache.get(user.id);
  if (hit && Date.now() - hit.at < 60_000) {
    return hit.ok ? { userId: user.id, email: hit.email, reason: null } : { reason: 'not_approved' };
  }
  const { data, error } = await supabase.from('user_approvals').select('approved').eq('user_id', user.id).maybeSingle();
  if (error) {
    // Not cached: a Supabase hiccup must not lock someone out for a minute.
    console.error(`[auth] approval lookup failed for ${user.id}: ${error.message}`);
    return { reason: 'check_failed' };
  }
  const ok = !!data?.approved;
  approvalCache.set(user.id, { ok, at: Date.now(), email: user.email || null });
  if (!ok) {
    console.warn(`[auth] user ${user.id} refused: ${data ? 'approved is false' : 'no row in user_approvals (or the server key cannot read it)'}`);
    return { reason: 'not_approved' };
  }
  return { userId: user.id, email: user.email || null, reason: null };
}
async function authedApprovedUserId(token) {
  const r = await authCheck(token);
  return r.userId || null;
}

// ---------------------------------------------------------------------------
// WhatsApp access lock + minutes (see lib/whatsappAccess.js, sql/011).
// Locked by default; the admin opens it per user with a number of minutes;
// Pro is unlimited. Enforced HERE because this is the server that actually
// pairs sessions and places calls.
// ---------------------------------------------------------------------------
const accessCache = new Map(); // userId -> { at, access }
const isTestAuth = () => process.env.NODE_ENV === 'test' && process.env.LIVE_CALL_TEST_AUTH === '1';
const isAdminEmail = (email) =>
  !!email && !!process.env.ADMIN_EMAIL && email.trim().toLowerCase() === process.env.ADMIN_EMAIL.trim().toLowerCase();

async function whatsappAccessFor(userId, { fresh = false } = {}) {
  if (isTestAuth()) {
    // Test harness only: LIVE_CALL_TEST_WA_ACCESS = "locked" | "open:<minutes>" | "pro".
    const forced = process.env.LIVE_CALL_TEST_WA_ACCESS || '';
    if (forced === 'locked') return evaluateAccess(null);
    if (forced.startsWith('open:')) return evaluateAccess({ unlocked: true, minutes_granted: Number(forced.slice(5)) });
    if (forced === 'pro') return evaluateAccess({ plan: 'pro' });
    return { allowed: true, unlimited: true, plan: 'test', minutesRemaining: null, reason: null };
  }
  const hit = accessCache.get(userId);
  if (!fresh && hit && Date.now() - hit.at < 10_000) return hit.access;
  const email = approvalCache.get(userId)?.email || null;
  let row = null;
  try {
    const { data, error } = await getServiceClient().from('whatsapp_access').select('*').eq('user_id', userId).maybeSingle();
    if (error) {
      const missing = error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache/i.test(error.message || '');
      if (missing) {
        // The migration has not been run yet. Fail OPEN so deploying this code
        // before running sql/011 cannot lock everybody out; say so loudly.
        console.error('[access] whatsapp_access table is missing - run sql/011_whatsapp_access.sql. WhatsApp is NOT locked until then.');
        return { allowed: true, unlimited: true, plan: 'unmetered', minutesRemaining: null, reason: null };
      }
      throw error;
    }
    row = data;
  } catch (e) {
    console.error(`[access] lookup failed for ${userId}: ${e.message}`);
    return { allowed: false, unlimited: false, plan: 'free', minutesRemaining: 0, reason: 'check_failed' };
  }
  const access = evaluateAccess(row, { isAdmin: isAdminEmail(email) });
  accessCache.set(userId, { at: Date.now(), access });
  return access;
}
function denyWhatsapp(res, access) {
  const code = access.reason === 'no_minutes' ? 'whatsapp_no_minutes' : 'whatsapp_locked';
  const error = access.reason === 'check_failed'
    ? 'Could not check your WhatsApp access right now. Try again in a moment.'
    : (ACCESS_MESSAGES[access.reason] || ACCESS_MESSAGES.locked);
  res.writeHead(access.reason === 'check_failed' ? 503 : 403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error, code, access }));
}

// Call time is metered from the moment the call CONNECTS (not while it rings)
// to the moment it ends, and charged once per call.
const chargedCalls = new Set();
async function chargeWhatsappMinutes(record) {
  const uid = currentUserId();
  if (!uid || isTestAuth() || record?.platform !== 'whatsapp' || !record.connectedAt) return;
  const key = record.callId || record.id;
  if (!key || chargedCalls.has(key)) return;
  chargedCalls.add(key);
  if (chargedCalls.size > 500) chargedCalls.delete(chargedCalls.values().next().value);
  const minutes = Math.max(0, ((record.endedAt || Date.now()) - record.connectedAt) / 60000);
  if (minutes <= 0) return;
  try {
    const { error } = await getServiceClient().rpc('whatsapp_add_minutes_used', { p_user: uid, p_minutes: Math.round(minutes * 100) / 100 });
    if (error) throw error;
    accessCache.delete(uid);
    console.log(`[access] charged ${minutes.toFixed(2)} min to ${uid}`);
  } catch (e) {
    console.error(`[access] could not record ${minutes.toFixed(2)} min for ${uid}: ${e.message}`);
  }
}

// A call on a limited allowance is ended when the minutes run out.
const callLimitTimers = new Map(); // userId -> timeout
function clearCallLimit() {
  const uid = currentUserId();
  if (uid && callLimitTimers.has(uid)) { clearTimeout(callLimitTimers.get(uid)); callLimitTimers.delete(uid); }
}
async function armCallLimit(call) {
  const uid = currentUserId();
  if (!uid || !call || call.platform !== 'whatsapp' || isTestAuth()) return;
  clearCallLimit();
  const access = await whatsappAccessFor(uid, { fresh: true });
  if (!access.allowed || access.unlimited) return;
  const ms = Math.max(1000, access.minutesRemaining * 60000);
  const t = setTimeout(() => userContext.run({ userId: uid }, () => endCallForLimit(call.callId)), ms);
  callLimitTimers.set(uid, t);
  console.log(`[access] ${uid} has ${access.minutesRemaining} min: call ${call.callId} will end in ${Math.round(ms / 1000)}s`);
}
async function endCallForLimit(callId) {
  const c = activeCall.v;
  if (!c || (callId && c.callId !== callId)) return;
  console.log(`[access] minutes used up - ending call ${c.callId}`);
  try { if (c.provider === 'wacalls' && c.callId) await wacalls.endCall(c.callId); }
  catch (e) { console.warn(`[access] could not end call ${c.callId}: ${e.message}`); }
  broadcastMediaEvent({ type: 'call_state', state: 'ended', reason: 'minutes_used_up', call: c });
  const sec = Math.round((Date.now() - c.startedAt) / 1000);
  saveCallHistory({ ...c, status: 'ended', reason: 'minutes_used_up', duration: `${Math.floor(sec / 60)}m ${sec % 60}s`, endedAt: Date.now() });
  activeCall.v = null;
  stopWacallsStatePoll();
}
// The one place a call becomes "connected": stamps the time the meter starts.
function markConnected(call) {
  if (!call) return;
  call.status = 'connected';
  if (!call.connectedAt) { call.connectedAt = Date.now(); armCallLimit(call).catch(() => {}); }
}

let tgCallsStatePoll = null;

// Polls tgcalls_bridge's real call state (idle/ringing/connecting/connected/
// ended/failed - see server/tgcalls_bridge/src/main.rs's CallState enum)
// and forwards changes to the frontend as call_state broadcasts. Without
// this, the only call_state event ever sent was the initial "calling" one
// right after placing the call - the UI had no way to ever learn the call
// actually connected (or failed), so it stayed on "Ringing..." forever
// regardless of what really happened.
function startTgCallsStatePoll() {
  stopTgCallsStatePoll();
  let lastState = null;
  tgCallsStatePoll = setInterval(async () => {
    const r = await proxyToTgCalls('/call/state', 'GET');
    const state = r.data?.state;
    if (!state || state === lastState) return;
    lastState = state;

    if (state === 'connected') {
      if (activeCall.v) markConnected(activeCall.v);
      broadcastMediaEvent({ type: 'call_state', state: 'connected', call: activeCall.v });
    } else if (state === 'ringing' || state === 'connecting') {
      broadcastMediaEvent({ type: 'call_state', state, call: activeCall.v });
    } else if (state === 'failed') {
      broadcastMediaEvent({ type: 'call_state', state: 'failed', error: r.data?.error, call: activeCall.v });
      stopTgCallsStatePoll();
    } else if (state === 'ended') {
      broadcastMediaEvent({ type: 'call_state', state: 'ended', call: activeCall.v });
      stopTgCallsStatePoll();
    }
  }, 1000);
}

function stopTgCallsStatePoll() {
  if (tgCallsStatePoll) { clearInterval(tgCallsStatePoll); tgCallsStatePoll = null; }
}

// Keep-alive ping (test-mode only, toggled from the app).
//
// This does NOT run its own internal timer - a setInterval only fires while
// the Node process is already alive, so it can't wake the service back up
// once it's actually spun down, and it silently resets to "off" on every
// restart/redeploy. Instead, the toggle enables/disables a GitHub Actions
// scheduled workflow (.github/workflows/keepalive.yml) that pings this
// service from GitHub's infrastructure every 10 min, independent of
// whatever state this process is in. A disabled workflow simply never
// runs, so "off" means genuinely undisturbed, not just "not pinging for
// now until the next restart resets the flag."
const GITHUB_REPO = 'multipurps/live-call';
const KEEPALIVE_WORKFLOW_ID = 'keepalive.yml';

async function githubApi(path, method = 'GET') {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not configured on this service');
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'live-call-keepalive',
    },
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `GitHub API error ${res.status}`);
  return data;
}

// Start Telegram Bridge Python process
let tgProcess = null;
let tgFastExits = 0;
function startTelegramBridge() {
  // On by default. Set DISABLE_TELEGRAM_BRIDGE=1 to turn it off.
  if (process.env.DISABLE_TELEGRAM_BRIDGE === '1') {
    console.log('[Server] Telegram bridge disabled (DISABLE_TELEGRAM_BRIDGE=1)');
    return;
  }
  const scriptPath = path.join(__dirname, 'server', 'telegram_bridge.py');
  if (!fs.existsSync(scriptPath)) return;

  console.log('[Server] Launching Telegram Bridge daemon...');
  const startedAt = Date.now();
  tgProcess = spawn('python3', [scriptPath], {
    env: { ...process.env, TG_PORT: String(TG_PORT), PYTHONPATH: [path.join(__dirname, 'pylibs'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  tgProcess.stdout.on('data', (d) => console.log(`[TgBridge] ${d.toString().trim()}`));
  tgProcess.stderr.on('data', (d) => console.error(`[TgBridge] ${d.toString().trim()}`));
  tgProcess.on('error', (err) => console.error(`[TgBridge] Could not start python3: ${err.message}`));

  tgProcess.on('exit', (code) => {
    // Quick repeated exits mean broken Python deps: back off, then stop instead of looping forever.
    tgFastExits = (Date.now() - startedAt < 60000) ? tgFastExits + 1 : 0;
    if (tgFastExits >= 5) {
      console.error(`[TgBridge] Exited ${tgFastExits} times in a row (last code ${code}) - giving up. Check the Python deps in requirements.txt.`);
      return;
    }
    const delay = Math.min(60000, 5000 * 2 ** tgFastExits);
    console.warn(`[TgBridge] Exited with code ${code}, restarting in ${delay / 1000}s...`);
    setTimeout(startTelegramBridge, delay);
  });
}

// Start the madeline_bridge PHP process - real Telegram P2P calling.
// REPLACES the previous Rust/ferogram tgcalls_bridge, which compiled and
// ran but never confirmed an actual ring in real testing. MadelineProto
// has a documented, mature requestCall()/VoIP API (see
// server/madeline_bridge/bridge.php for details on what was verified).
// UNVERIFIED as of this commit - could not test PHP/composer/amphp at all
// locally; expect iteration against Render's real build/runtime logs,
// same as the Rust bridge needed.
let tgCallsProcess = null;
function startTgCallsBridge() {
  const bridgeDir = path.join(__dirname, 'server', 'madeline_bridge');
  const scriptPath = path.join(bridgeDir, 'bridge.php');
  const vendorPath = path.join(bridgeDir, 'vendor', 'autoload.php');
  // Static, self-contained PHP binary downloaded by build.sh (no apt/root
  // needed - Render's build container is non-root with a read-only apt,
  // confirmed from a real build log) - not a global `php` on PATH.
  const phpBinPath = path.join(bridgeDir, 'php-bin', 'bin', 'php');
  if (!fs.existsSync(phpBinPath) || !fs.existsSync(scriptPath) || !fs.existsSync(vendorPath)) {
    console.warn('[Server] madeline_bridge not found or its build did not complete - real Telegram calling unavailable, PyTgCalls-only.');
    return;
  }

  console.log('[Server] Launching madeline_bridge (real Telegram P2P calling via MadelineProto) daemon...');
  tgCallsProcess = spawn(phpBinPath, [scriptPath], {
    env: { ...process.env, TGCALLS_PORT: String(TGCALLS_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  tgCallsProcess.stdout.on('data', (d) => console.log(`[TgCallsBridge] ${d.toString().trim()}`));
  tgCallsProcess.stderr.on('data', (d) => console.error(`[TgCallsBridge] ${d.toString().trim()}`));

  tgCallsProcess.on('exit', (code) => {
    // URGENT SAFETY FIX: this used to restart on a flat 5s timer. When
    // MadelineProto's start() auto-triggers its own interactive CLI QR
    // login on every boot (see bridge.php's TODO on this), a crash-loop
    // here means repeatedly hitting Telegram's real login endpoint every
    // ~5 seconds - confirmed live: this actually happened and produced a
    // real, escalating FLOOD_WAIT rate-limit response from Telegram's
    // servers. A tight restart loop against a real external API is
    // active harm, not just wasted resources - exponential backoff with a
    // hard cap, and a full stop after repeated failures, is mandatory
    // here, not optional hardening.
    tgCallsRestartCount = (tgCallsRestartCount || 0) + 1;
    if (tgCallsRestartCount > 5) {
      console.error(`[TgCallsBridge] Exited with code ${code} for the ${tgCallsRestartCount}th time - giving up auto-restart to avoid hammering Telegram's API. Fix the underlying issue and redeploy.`);
      return;
    }
    const backoffMs = Math.min(30000 * tgCallsRestartCount, 300000); // 30s, 60s, ... capped at 5min
    console.warn(`[TgCallsBridge] Exited with code ${code}, restarting in ${backoffMs / 1000}s (attempt ${tgCallsRestartCount}/5)...`);
    setTimeout(startTgCallsBridge, backoffMs);
  });
}
let tgCallsRestartCount = 0;

// Helper to proxy HTTP requests to Telegram bridge
async function proxyToTg(endpoint, method = 'GET', body = null) {
  const url = `http://127.0.0.1:${TG_PORT}${endpoint}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    return { status: res.status, data: await res.json().catch(() => ({})) };
  } catch (err) {
    return { status: 502, data: { error: `Telegram bridge unavailable: ${err.message}` } };
  }
}

// Helper to proxy HTTP requests to the tgcalls_bridge (real P2P calling)
async function proxyToTgCalls(endpoint, method = 'GET', body = null) {
  const url = `http://127.0.0.1:${TGCALLS_PORT}${endpoint}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    return { status: res.status, data: await res.json().catch(() => ({})) };
  } catch (err) {
    return { status: 502, data: { error: `Real-calling bridge unavailable: ${err.message}` } };
  }
}

// ---------------------------------------------------------------
// tgcalls_bridge media pipes: the outgoing video/audio frames the
// frontend already sends over the media WebSocket (channel 0x01 = JPEG
// video frame, 0x02 = PCM mic audio - see wss.on('connection') below)
// were previously just received and dropped; nothing ever consumed
// them. For a real Telegram P2P call, tgcalls_bridge's set_media() reads
// outgoing audio/video from two named pipes (see
// server/tgcalls_bridge/src/main.rs's run_call) since P2PCall has no
// live external-frame push API, only file/pipe-backed ingestion via
// ffmpeg. These functions create those pipes and keep write streams
// open into them for the duration of an active Telegram call.
// ---------------------------------------------------------------
const TGCALLS_AUDIO_PIPE = '/tmp/tgcalls_audio.pcm';
const TGCALLS_VIDEO_PIPE = '/tmp/tgcalls_video.mjpeg';
let tgCallsAudioStream = null;
let tgCallsVideoStream = null;

function makeFreshFifo(fifoPath) {
  try { fs.unlinkSync(fifoPath); } catch (e) { /* didn't exist - fine */ }
  execFileSync('mkfifo', [fifoPath]);
}

function openTgCallsPipes() {
  // A FIFO's open() blocks until the other end is also opened - that's
  // expected and harmless here: Node's fs streams don't block the event
  // loop while waiting, they just fire 'open' once tgcalls_bridge's
  // ffmpeg reader attaches (which happens inside set_media(), itself
  // only called after the call actually connects). Frames arriving over
  // the WS before that just get buffered in the stream's internal
  // buffer, which is fine for the short ringing/connecting window.
  try {
    makeFreshFifo(TGCALLS_AUDIO_PIPE);
    makeFreshFifo(TGCALLS_VIDEO_PIPE);
  } catch (e) {
    console.error('[TgCallsPipes] Failed to create FIFOs (mkfifo unavailable?):', e.message);
    return;
  }

  tgCallsAudioStream = fs.createWriteStream(TGCALLS_AUDIO_PIPE);
  tgCallsVideoStream = fs.createWriteStream(TGCALLS_VIDEO_PIPE);
  tgCallsAudioStream.on('error', (e) => console.warn('[TgCallsPipes] audio pipe error:', e.message));
  tgCallsVideoStream.on('error', (e) => console.warn('[TgCallsPipes] video pipe error:', e.message));
  tgCallsAudioStream.on('open', () => console.log('[TgCallsPipes] audio pipe reader attached'));
  tgCallsVideoStream.on('open', () => console.log('[TgCallsPipes] video pipe reader attached'));
  console.log('[TgCallsPipes] Opened audio/video pipes for tgcalls_bridge');
}

function closeTgCallsPipes() {
  if (tgCallsAudioStream) { tgCallsAudioStream.destroy(); tgCallsAudioStream = null; }
  if (tgCallsVideoStream) { tgCallsVideoStream.destroy(); tgCallsVideoStream = null; }
  try { fs.unlinkSync(TGCALLS_AUDIO_PIPE); } catch (e) {}
  try { fs.unlinkSync(TGCALLS_VIDEO_PIPE); } catch (e) {}
}

// ---------------------------------------------------------------
// WaCalls - the WhatsApp calling backend (server/wacalls.mjs).
//
// WaCalls is an EXTERNAL service, reached over HTTP with an API key that only
// ever lives here on the server (see server/wacalls.mjs). Nothing is spawned
// locally: the base URL comes from WACALLS_URL, the key from WACALLS_API_KEY.
//
// What this block does:
//   1. subscribes to WaCalls' event stream (SSE, /api/events) and re-emits
//      every normalised event on the media WebSocket that already carries
//      call_state to the frontend, so incoming calls, accept/reject, end and
//      media-ready/not-ready reach the UI the same way call state always has;
//   2. mirrors the call lifecycle onto the existing activeCall.v record
//      (status label, ringback, end-on-failure) so the Active Call screen
//      needs no engine-specific plumbing for that part;
//   3. logs the video capability of the instance it is talking to, so an
//      audio-only WaCalls build is visible in the log rather than showing up
//      later as video that never appears.
//
// The media plane is NOT here: WaCalls carries call media over WebRTC data
// channels between the browser and the WaCalls server ("pcm" = 16 kHz mono
// s16le both ways, "vp8" = encoded H.264 access units both ways). server.mjs
// proxies only the SDP offer/answer (route below), which is what keeps the
// API key out of the page while the media path stays browser <-> WaCalls.
// ---------------------------------------------------------------
const wacallsPolls = new Map(); // userId -> interval

function startWacallsStatePoll() {
  stopWacallsStatePoll();
  const uid = currentUserId() || '_none';
  // setInterval keeps the user context it was created in.
  wacallsPolls.set(uid, setInterval(async () => {
    if (!activeCall.v?.callId || activeCall.v.provider !== 'wacalls') return;
    try {
      const info = await wacalls.getCall(activeCall.v.callId);
      const state = info?.state;
      if (!state || state === activeCall.v.wacallsState) return;
      activeCall.v.wacallsState = state;
      if (state === 'active') {
        if (activeCall.v.status !== 'connected') {
          markConnected(activeCall.v);
          console.log(`[WaCalls] call ${activeCall.v.callId} is ACTIVE - media ready`);
          broadcastMediaEvent({ type: 'call_state', state: 'connected', call: activeCall.v });
        }
      } else if (state === 'ringing' || state === 'initiating' || state === 'held') {
        broadcastMediaEvent({ type: 'call_state', state: state === 'held' ? 'connecting' : 'ringing', call: activeCall.v });
      } else if (state === 'ended') {
        console.log(`[WaCalls] call ${activeCall.v.callId} ended`);
        broadcastMediaEvent({ type: 'call_state', state: 'ended', call: activeCall.v });
        stopWacallsStatePoll();
      }
    } catch (e) {
      // A polling failure is not itself a call failure (a transient blip must
      // not hang up a live call) - the event stream is the source of truth for
      // the call ending; this poll only fills in gaps.
    }
  }, 1500));
}

function stopWacallsStatePoll() {
  const uid = currentUserId() || '_none';
  const t = wacallsPolls.get(uid);
  if (t) { clearInterval(t); wacallsPolls.delete(uid); }
}

// One WaCalls event -> the existing frontend surfaces.
//
//  * `call_state` keeps the existing Active Call screen working unchanged
//    (status label, ringback, auto-end on failure).
//  * `wa_call_event` mirrors the shape the Green API path already uses, so the
//    status-line handler in app.src.js works for both engines.
//  * `wacalls_event` is the full normalised event (kind: incoming | accepted |
//    rejected | ended | media-ready | media-not-ready | video-request | error)
//    - this is what the WaCalls-specific UI (incoming-call banner, avatar
//    source state) listens to, including the media-ready/not-ready pair the
//    integration is required to expose.
wacalls.subscribe((evt) => {
  // Events from the shared WaCalls instance cover every user's sessions. Each
  // one is handled as the user who owns that session, so call state and the
  // media-socket broadcast reach only them.
  const owner = evt.sessionId ? wacalls.ownerOf(evt.sessionId) : null;
  if (!owner) return;
  userContext.run({ userId: owner }, () => handleWacallsEvent(evt));
});

function handleWacallsEvent(evt) {
  const payload = {
    type: 'wacalls_event',
    kind: evt.kind,
    subtype: evt.subtype || null,
    callId: evt.callId || null,
    peer: evt.peer || null,
    media: evt.media || null,
    status: evt.status || null,
    reason: evt.reason || null,
    direction: evt.direction || null,
    error: evt.error || null,
  };

  if (evt.kind === 'incoming' && evt.callId) {
    console.log(`[WaCalls] INCOMING ${evt.media === 'video' ? 'VIDEO' : 'audio'} call from ${evt.peer || 'unknown'} (callId=${evt.callId})`);
    // Track it as the active call unless one is already up (WaCalls allows one
    // active call per client id; a second offer is not something this app can
    // act on anyway). Recording it here - rather than only in the page - is
    // what makes answering an INCOMING call behave like an outgoing one for
    // everything else: the state poll, the avatar switch, the hangup route
    // (which is where the call is actually deleted on WaCalls) and the call
    // history record.
    if (!activeCall.v || activeCall.v.callId === evt.callId) {
      activeCall.v = {
        id: 'call_' + Date.now(),
        platform: 'whatsapp',
        provider: 'wacalls',
        direction: 'incoming',
        target: evt.peer || 'unknown',
        name: evt.peer || 'unknown',
        startedAt: Date.now(),
        status: 'ringing',
        callId: evt.callId,
        sessionId: evt.sessionId || null,
        videoRequested: evt.media === 'video',
        avatarSource: 'lucy',
      };
      startWacallsStatePoll();
    }
    broadcastMediaEvent({ type: 'wa_call_event', call: { id: evt.callId, status: 'offer', peer: evt.peer, media: evt.media, direction: 'incoming' } });
    broadcastMediaEvent({ ...payload, type: 'wacalls_event' });
    return;
  }

  if (evt.kind === 'accepted') {
    console.log(`[WaCalls] call accepted (callId=${evt.callId || 'unknown'})`);
    broadcastMediaEvent({ type: 'wa_call_event', call: { id: evt.callId, status: 'accept' } });
  } else if (evt.kind === 'ended') {
    console.log(`[WaCalls] call ended: callId=${evt.callId || 'unknown'} reason=${evt.reason || 'unknown'}`);
    broadcastMediaEvent({ type: 'wa_call_event', call: { id: evt.callId, status: 'terminate', reason: evt.reason } });
    broadcastMediaEvent({ type: 'call_state', state: 'ended', call: activeCall.v });
    // An incoming call that ended without ever being answered has no browser
    // side to hang up: the record it created here is closed out and saved now.
    if (activeCall.v && (!evt.callId || activeCall.v.callId === evt.callId)) {
      if (activeCall.v.status !== 'ended') {
        const durationSec = Math.round((Date.now() - activeCall.v.startedAt) / 1000);
        saveCallHistory({
          ...activeCall.v,
          status: activeCall.v.status === 'ringing' ? 'missed' : 'ended',
          reason: evt.reason || null,
          duration: `${durationSec}s`,
          endedAt: Date.now(),
        });
      }
      activeCall.v = null;
    }
    stopWacallsStatePoll();
  } else if (evt.kind === 'media-ready') {
    console.log(`[WaCalls] media READY for callId=${evt.callId || 'unknown'} (${evt.subtype})`);
    if (activeCall.v && (!evt.callId || activeCall.v.callId === evt.callId)) {
      markConnected(activeCall.v);
      if (evt.media) activeCall.v.media = evt.media;
      broadcastMediaEvent({ type: 'call_state', state: 'connected', call: activeCall.v });
    }
  } else if (evt.kind === 'media-not-ready') {
    // Includes call-status events before "connected" and the held state.
    if (evt.subtype === 'call-status' && evt.media) {
      const downgrade = wacalls.noteCallMedia(evt.callId, evt.media, activeCall.v?.videoRequested);
      if (downgrade) payload.videoDowngrade = downgrade;
    }
  } else if (evt.kind === 'video-request') {
    console.log(`[WaCalls] the peer asked to switch callId=${evt.callId} to video`);
  } else if (evt.kind === 'error') {
    console.error(`[WaCalls] event stream error: ${evt.error}`);
  }

  broadcastMediaEvent(payload);
}

// Parse request body
// Parse request body
function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        resolve({ raw });
      }
    });
  });
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  // CORS & Preview headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // -------------------------------------------------------------
  // Social Call API endpoints
  // -------------------------------------------------------------
  if (pathname.startsWith('/api/social-call/')) {
    const subpath = pathname.replace('/api/social-call/', '');

    // Everything here acts on the caller's OWN accounts and calls, so the
    // caller must be signed in and approved. From here on this request runs in
    // that user's context (their WhatsApp session, their active call).
    let auth;
    try {
      auth = await authCheck((req.headers.authorization || '').replace('Bearer ', ''));
    } catch (e) {
      console.error('[auth] unexpected: ' + e.message);
      auth = { reason: 'check_failed' };
    }
    if (!auth.userId) {
      const f = AUTH_FAILURES[auth.reason] || AUTH_FAILURES.check_failed;
      res.writeHead(f.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: f.error, code: auth.reason }));
    }
    const callerId = auth.userId;
    userContext.enterWith({ userId: callerId });

    // WhatsApp connect lock: pairing, answering and placing WhatsApp calls need
    // access. Status / disconnect / logout stay open so the screen can say WHY
    // it is locked and a user can still unlink their own number.
    const WA_GATED = new Set(['whatsapp/qr', 'whatsapp/call-config', 'wacalls/qr', 'wacalls/pair', 'wacalls/pair-phone', 'wacalls/call', 'wacalls/answer']);
    if (WA_GATED.has(subpath)) {
      const access = await whatsappAccessFor(callerId);
      if (!access.allowed) return denyWhatsapp(res, access);
    }

    // Overall status of connected accounts
    if (subpath === 'status' && req.method === 'GET') {
      let waStatus;
      try {
        const creds = await requireGreenApiCreds(req);
        waStatus = await greenApi.getStatus(creds);
      } catch (e) {
        waStatus = { connected: false, error: e.message };
      }
      const tgStatus = await proxyToTg('/tg/status', 'GET');
      // WaCalls' own state, in the same response: the Profile screen shows
      // whichever engine is selected, and the WaCalls entry must be the real
      // state of the external instance (configured? reachable? paired? does
      // it do video?), not an assumption.
      let wacallsStatus = null;
      if (wacallsConfigured()) {
        wacallsStatus = await wacalls.publicStatus({});
      } else {
        wacallsStatus = {
          configured: false,
          state: 'not_configured',
          error: 'Set WACALLS_URL on the server (and WACALLS_API_KEY if your instance requires one) to enable WhatsApp calls through WaCalls.',
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        whatsapp: waStatus,
        wacalls: wacallsStatus,
        telegram: tgStatus.data,
        access: await whatsappAccessFor(callerId),
      }));
    }

    // Call history
    if ((subpath === 'history' || subpath === 'recent') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ history: callHistory }));
    }

    // WhatsApp endpoints - every one of these acts on the AUTHENTICATED
    // CALLER's own Green API credentials, never a shared/global instance.
    if (subpath === 'whatsapp/qr' && (req.method === 'POST' || req.method === 'GET')) {
      try {
        const creds = await requireGreenApiCreds(req);
        const qrData = await greenApi.getQrCode(creds);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(qrData));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // Hands the frontend what it needs to init the Green API calls SDK
    // directly (client-side WebRTC) - see app.src.js. Returns THIS
    // caller's own credentials, resolved the same way as every other
    // whatsapp/* route. The api token is necessarily exposed to the
    // browser here; that's inherent to how Green API's calling SDK is
    // designed to be used, not something avoidable while using their
    // library as documented.
    if (subpath === 'whatsapp/call-config' && req.method === 'GET') {
      try {
        const creds = await requireGreenApiCreds(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(creds));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    if (subpath === 'whatsapp/contacts' && req.method === 'GET') {
      try {
        const creds = await requireGreenApiCreds(req);
        const contacts = await greenApi.getContacts(creds);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ contacts }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message, contacts: [] }));
      }
    }

    if (subpath === 'whatsapp/disconnect' && req.method === 'POST') {
      try {
        const creds = await requireGreenApiCreds(req);
        const result = await greenApi.disconnect(creds);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // ---------------------------------------------------------------
    // WaCalls backend (SEPARATE from Green API above).
    //
    // No Green API credentials are read anywhere in this block, and no
    // WaCalls credential ever leaves this process: the API key is added by
    // server/wacalls.mjs on every outbound request, and every response below
    // is the public status shape (built field by field - see publicStatus()).
    // The browser gets connection state, the linked number and a QR *image*,
    // exactly like the Green API routes hand it.
    // ---------------------------------------------------------------

    // Live WaCalls status: configured / reachable / paired / video-capable.
    // `?probe=1` also re-runs the video capability probe (it is cached, and
    // normally refreshed on demand rather than on every poll).
    if (subpath === 'wacalls/status' && req.method === 'GET') {
      const probe = parsedUrl.searchParams.get('probe') === '1';
      // `force` re-runs the cached video capability probe - used right after
      // the instance was rebuilt/upgraded, when the cached answer is stale.
      const force = parsedUrl.searchParams.get('force') === '1';
      const status = await wacalls.publicStatus({ probe, force });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(status));
    }

    // Pairing QR. WaCalls' event stream carries the raw QR payload string
    // (whatsmeow's, not an image), so it is rendered into a PNG data URL here
    // with the `qrcode` dependency this project already ships - the same
    // approach the previous engine's /qr route used, so the Profile screen
    // needs no change to display it.
    if (subpath === 'wacalls/qr' && (req.method === 'GET' || req.method === 'POST')) {
      const status = await wacalls.publicStatus({});
      if (!status.configured) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: status.error }));
      }
      if (status.paired) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ alreadyAuthorized: true, phone: status.phone, sessionId: status.sessionId }));
      }
      const payload = wacalls.qrPayload();
      if (!payload) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: status.error || 'No pairing QR yet - WaCalls is still connecting. It arrives over /api/events; tap Refresh in a moment.',
          sessionId: status.sessionId,
        }));
      }
      const dataUrl = await QRCode.toDataURL(payload, { margin: 2, width: 260 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ qr: payload, dataUrl, sessionId: status.sessionId }));
    }

    // (Re)start pairing on the WaCalls session this app drives. Idempotent
    // from the caller's point of view: the QR then shows up on the next /qr
    // call (and is pushed over the event stream as session-qr).
    if (subpath === 'wacalls/pair' && req.method === 'POST') {
      try {
        const result = await wacalls.pairSession();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    if (subpath === 'wacalls/pair-phone' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const result = await wacalls.pairPhone(String(body.phone || ''));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    if (subpath === 'wacalls/logout' && req.method === 'POST') {
      try {
        const result = await wacalls.logoutSession();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // Call control. These are thin, explicit proxies: the frontend never talks
    // to WaCalls itself for control, so the key stays server-side.
    if (subpath.startsWith('wacalls/')) {
      const tail = subpath.replace('wacalls/', '');
      const body = req.method === 'POST' ? await parseBody(req) : {};

      try {
        // OUTGOING video call. WaCalls places the real WhatsApp call; the
        // browser then opens its media leg (browser <-> WaCalls) through the
        // /wacalls/webrtc route below, carrying the live avatar.
        if (tail === 'call' && req.method === 'POST') {
          const video = body.video !== false;
          const r = await wacalls.startCall({ target: body.target, video, name: body.name });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, video, ...r }));
        }

        if (tail === 'answer' && req.method === 'POST') {
          const r = await wacalls.answerCall(body.callId);
          if (activeCall.v && (!body.callId || activeCall.v.callId === body.callId)) {
            activeCall.v.status = 'connecting';
            broadcastMediaEvent({ type: 'call_state', state: 'connecting', call: activeCall.v });
          }
          console.log(`[WaCalls] incoming call answered from the app: callId=${body.callId}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, ...r }));
        }

        if (tail === 'reject' && req.method === 'POST') {
          const r = await wacalls.rejectCall(body.callId);
          if (activeCall.v && activeCall.v.callId === body.callId) {
            const durationSec = Math.round((Date.now() - activeCall.v.startedAt) / 1000);
            saveCallHistory({ ...activeCall.v, status: 'rejected', duration: `${durationSec}s`, endedAt: Date.now() });
            activeCall.v = null;
            stopWacallsStatePoll();
          }
          broadcastMediaEvent({ type: 'call_state', state: 'ended', call: null });
          console.log(`[WaCalls] incoming call declined: callId=${body.callId}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, ...r }));
        }

        if (tail === 'end' && req.method === 'POST') {
          const r = await wacalls.endCall(body.callId);
          stopWacallsStatePoll();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, ...r }));
        }

        // The SDP offer/answer relay. The offer comes from the browser; only
        // the answer goes back. Media itself never passes through here.
        if (tail === 'webrtc' && req.method === 'POST') {
          const answer = await wacalls.submitOffer(body.callId, body.sdp_offer, { renegotiate: false });
          console.log(`[WaCalls] browser media leg negotiated for callId=${body.callId} (media-ready)`);
          broadcastMediaEvent({ type: 'wacalls_event', kind: 'media-ready', subtype: 'webrtc', callId: body.callId });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ sdp_answer: answer }));
        }

        if (tail === 'webrtc/renegotiate' && req.method === 'POST') {
          const answer = await wacalls.submitOffer(body.callId, body.sdp_offer, { renegotiate: true });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ sdp_answer: answer }));
        }

        if (tail === 'video/start' && req.method === 'POST') {
          const r = await wacalls.videoStart(body.callId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, ...r }));
        }

        if (tail === 'video/stop' && req.method === 'POST') {
          const r = await wacalls.videoStop(body.callId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, ...r }));
        }

        if (tail === 'video/accept' && req.method === 'POST') {
          const r = await wacalls.videoAccept(body.callId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, ...r }));
        }

        if ((tail === 'call' || tail === 'calls') && req.method === 'GET') {
          const info = await wacalls.getCall(parsedUrl.searchParams.get('callId'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(info));
        }

        // Avatar source switching is recorded (and logged) here so a switch
        // mid-call is visible in the server log next to the call itself; the
        // pixels are switched client-side by the media leg, which owns the
        // encoder. Never fails the call: a logging hiccup must not drop video.
        if (tail === 'avatar' && req.method === 'POST') {
          const source = body.source === 'anam' ? 'anam' : 'lucy';
          if (activeCall.v) {
            activeCall.v.avatarSource = source;
            activeCall.v.avatarSwitchedAt = Date.now();
          }
          console.log(`[WaCalls] avatar video source switched to ${source === 'anam' ? 'Anam' : 'Lucy 2.5'}${activeCall.v ? ` for callId=${activeCall.v.callId || 'pending'}` : ' (no active call)'}`);
          broadcastMediaEvent({ type: 'wacalls_event', kind: 'avatar-switched', source, callId: activeCall.v?.callId || null });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, source, callId: activeCall.v?.callId || null }));
        }

        // Text messaging is deliberately not proxied: WaCalls has no
        // send-message endpoint in either build, and this app has no WhatsApp
        // send-text path. An explicit 501 beats a route that looks like it
        // works (see sendText() in server/wacalls.mjs).
        if (tail === 'messages' && req.method === 'POST') {
          const r = await wacalls.sendText();
          res.writeHead(501, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(r));
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Unknown WaCalls route: ${tail}` }));
      } catch (e) {
        // The real reason from WaCalls (unreachable, 401 from a wrong API key,
        // no paired session, video refused, ...) - never a generic failure.
        console.error(`[WaCalls] ${tail} failed: ${e.message}`);
        res.writeHead(e.code === 'not_configured' ? 503 : 502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // ---------------------------------------------------------------
    // Real Telegram P2P calling auth (tgcalls_bridge) - a SEPARATE session
    // from the regular Telegram connection above. That connection (via
    // telegram_bridge.py/Pyrogram) is used for status/contacts and can't
    // place a real ringing call; this one (via ferogram/tgcalls) is used
    // only for actually placing/receiving calls. Two different MTProto
    // client implementations, so unfortunately two separate sign-ins.
    // ---------------------------------------------------------------
    if (subpath === 'telegram/p2p/status' && req.method === 'GET') {
      const r = await proxyToTgCalls('/status', 'GET');
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r.data));
    }
    if (subpath === 'telegram/p2p/send_code' && req.method === 'POST') {
      const body = await parseBody(req);
      const r = await proxyToTgCalls('/send_code', 'POST', body);
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r.data));
    }
    if (subpath === 'telegram/p2p/sign_in' && req.method === 'POST') {
      const body = await parseBody(req);
      const r = await proxyToTgCalls('/sign_in', 'POST', body);
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r.data));
    }
    if (subpath === 'telegram/p2p/disconnect' && req.method === 'POST') {
      const r = await proxyToTgCalls('/disconnect', 'POST');
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r.data));
    }
    if (subpath === 'telegram/p2p/call_state' && req.method === 'GET') {
      const r = await proxyToTgCalls('/call/state', 'GET');
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r.data));
    }


    // Telegram endpoints
    if (subpath === 'telegram/status' && req.method === 'GET') {
      const tgRes = await proxyToTg('/tg/status', 'GET');
      res.writeHead(tgRes.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(tgRes.data));
    }

    if ((subpath === 'telegram/send_code' || subpath === 'telegram/send-code') && req.method === 'POST') {
      const body = await parseBody(req);
      const tgRes = await proxyToTg('/tg/send_code', 'POST', body);
      res.writeHead(tgRes.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(tgRes.data));
    }

    if ((subpath === 'telegram/sign_in' || subpath === 'telegram/sign-in' || subpath === 'telegram/verify-code') && req.method === 'POST') {
      const body = await parseBody(req);
      const tgRes = await proxyToTg('/tg/sign_in', 'POST', body);
      res.writeHead(tgRes.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(tgRes.data));
    }

    if (subpath === 'telegram/contacts' && req.method === 'GET') {
      const tgRes = await proxyToTg('/tg/contacts', 'GET');
      res.writeHead(tgRes.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(tgRes.data));
    }

    if (subpath === 'telegram/resolve' && req.method === 'POST') {
      const body = await parseBody(req);
      const tgRes = await proxyToTg('/tg/resolve', 'POST', body);
      res.writeHead(tgRes.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(tgRes.data));
    }

    if (subpath === 'telegram/disconnect' && req.method === 'POST') {
      const tgRes = await proxyToTg('/tg/disconnect', 'POST');
      res.writeHead(tgRes.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(tgRes.data));
    }

    // Unified call placing endpoint
    if (subpath === 'call' && req.method === 'POST') {
      const body = await parseBody(req);
      const { platform, target, name, avatarUrl, provider, video, source } = body;
      if (!platform || !target) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing platform or target' }));
      }

      // WhatsApp engine selection. `provider` is honoured ONLY for WhatsApp
      // and defaults to 'greenapi', so an existing caller that sends no
      // provider keeps the exact behaviour it had before this existed.
      // Anything unrecognised is rejected rather than silently re-routed:
      // dialling through a backend the user did not choose is the one thing
      // this selection layer must never do.
      let waProvider = null;
      if (platform === 'whatsapp') {
        const callAccess = await whatsappAccessFor(callerId);
        if (!callAccess.allowed) return denyWhatsapp(res, callAccess);
        waProvider = provider || 'greenapi';
        if (!WHATSAPP_PROVIDERS.includes(waProvider)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `Unknown WhatsApp provider "${waProvider}" - expected one of ${WHATSAPP_PROVIDERS.join(', ')}` }));
        }
      }

      // WaCalls allows ONE active call per client id. A previous call that never
      // got a clean hangup (page closed or crashed mid-setup, media ICE failure)
      // still holds that slot, and the next call then never rings. Free it first.
      const staleCall = activeCall.v;
      if (platform === 'whatsapp' && waProvider === 'wacalls' && staleCall?.callId && staleCall.provider === 'wacalls') {
        try { await wacalls.endCall(staleCall.callId); console.log(`[WaCalls] released stale call ${staleCall.callId} before placing a new one`); }
        catch (e) { console.warn(`[WaCalls] could not release stale call ${staleCall.callId}: ${e.message}`); }
        stopWacallsStatePoll();
      }

      activeCall.v = {
        id: 'call_' + Date.now(),
        platform,
        provider: waProvider,
        target,
        name: name || target,
        avatarUrl,
        startedAt: Date.now(),
        status: 'calling',
      };

      try {
        if (platform === 'whatsapp' && waProvider === 'wacalls') {
          // REAL WhatsApp call, placed by the WaCalls service (offer + relay +
          // E2E media on its side), with the live avatar as the outgoing
          // video. `video` defaults on: this engine exists to make real
          // WhatsApp video calls, and `video:false` is a deliberate
          // audio-only call.
          //
          // The call is placed FIRST, and the browser then opens its media
          // leg for the returned callId (POST /api/social-call/wacalls/webrtc
          // - the SDP relay). Ordering matters: WaCalls' call id is what the
          // media leg attaches to.
          const wantVideo = video !== false;
          const r = await wacalls.startCall({ target, video: wantVideo, name: name || target });
          activeCall.v.callId = r.callId;
          activeCall.v.sessionId = r.sessionId;
          activeCall.v.videoRequested = wantVideo;
          activeCall.v.avatarSource = source === 'anam' ? 'anam' : 'lucy';
          console.log(`[WaCalls] outgoing ${wantVideo ? 'video' : 'audio'} call placed: callId=${r.callId} target=${target} avatar=${activeCall.v.avatarSource}`);
          // Media-ready is driven by WaCalls' own call-status event (see the
          // event bridge above); this poll is the safety net for the case
          // where the event stream misses a transition.
          startWacallsStatePoll();
        } else if (platform === 'whatsapp') {
          // No server-side call placement with Green API - the frontend
          // dials directly via the Green API calls SDK (client-side
          // WebRTC). This endpoint just records call state/history for
          // WhatsApp now; it does not itself cause any ringing.
        } else if (platform === 'telegram') {
          // Real P2P ringing via tgcalls_bridge, not PyTgCalls (which can't
          // ring a private contact - see server/telegram_bridge.py's
          // handle_call comments). Requires the account to have signed in
          // separately via the /p2p/* endpoints below - a different session
          // than the regular Telegram connection used for status/contacts.
          const numericTarget = Number(target);
          if (!Number.isFinite(numericTarget)) {
            throw new Error('Real calling needs a numeric Telegram user id as target');
          }
          // Open the media pipes BEFORE placing the call so they're ready
          // the moment tgcalls_bridge's set_media() looks for a reader -
          // opening is non-blocking on this side (see openTgCallsPipes).
          openTgCallsPipes();
          await proxyToTgCalls('/call', 'POST', { target: numericTarget });
          startTgCallsStatePoll();
        }

        broadcastMediaEvent({ type: 'call_state', state: 'calling', call: activeCall.v });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'call_started', call: activeCall.v }));
      } catch (err) {
        // Nothing half-placed is left behind: whatever the engine did before
        // failing is torn down (Telegram pipes, WaCalls state poll) and the
        // caller gets the real reason from WaCalls/the bridge, not a generic
        // failure.
        activeCall.v = null;
        closeTgCallsPipes();
        stopTgCallsStatePoll();
        stopWacallsStatePoll();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // -------------------------------------------------------------
    // Realtime RVC voice conversion (w-okada/voice-changer).
    // Lucy 2.5 supplies the avatar video only - this converts the live
    // audio that goes out with it. See server/voice_changer.mjs and
    // server/voicechanger/README.md.
    // -------------------------------------------------------------
    if (subpath === 'voice/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(voiceChanger.status()));
    }

    if (subpath === 'voice/models' && req.method === 'GET') {
      try {
        const models = await voiceChanger.listModels();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ models, selectedSlot: VC_CONFIG.modelSlot }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ models: [], selectedSlot: VC_CONFIG.modelSlot, error: e.message }));
      }
    }

    if (subpath === 'voice/select' && req.method === 'POST') {
      const body = await parseBody(req);
      try {
        await voiceChanger.selectModel(Number(body.slot));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(voiceChanger.status()));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ...voiceChanger.status(), error: e.message }));
      }
    }

    if (subpath === 'voice/settings' && req.method === 'POST') {
      const body = await parseBody(req);
      // Only the handful of knobs that make sense per-deployment; anything
      // else is set through voice-changer's own UI or env vars.
      const allowed = ['tran', 'indexRatio', 'protect', 'f0Detector', 'silentThreshold'];
      const applied = [];
      const errors = [];
      for (const key of allowed) {
        if (body[key] === undefined || body[key] === null || body[key] === '') continue;
        try {
          await voiceChanger.updateSetting(key, body[key]);
          if (key === 'tran') VC_CONFIG.tran = Number(body[key]);
          if (key === 'indexRatio') VC_CONFIG.indexRatio = Number(body[key]);
          if (key === 'protect') VC_CONFIG.protect = Number(body[key]);
          if (key === 'f0Detector') VC_CONFIG.f0Detector = String(body[key]);
          applied.push(key);
        } catch (e) {
          errors.push(`${key}: ${e.message}`);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ...voiceChanger.status(),
        applied,
        error: errors.length ? errors.join('; ') : null,
      }));
    }

    if (subpath === 'voice/start' && req.method === 'POST') {
      const body = await parseBody(req);
      const status = await startVoiceConversion({ platform: body.platform, modelSlot: body.modelSlot });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(status));
    }

    if (subpath === 'voice/stop' && req.method === 'POST') {
      const status = stopVoiceConversion();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(status));
    }

    if (subpath === 'voice/load-model' && req.method === 'POST') {
      // Loads an RVC checkpoint that already exists on this host into a
      // voice-changer model slot (upload -> concat -> load_model).
      const body = await parseBody(req);
      try {
        const result = await voiceChanger.loadModel({
          slot: Number(body.slot ?? 0),
          pthPath: body.pthPath,
          indexPath: body.indexPath,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ...result, status: voiceChanger.status() }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // Hangup endpoint
    if (subpath === 'hangup' && req.method === 'POST') {
      if (activeCall.v) {
        const durationSec = Math.round((Date.now() - activeCall.v.startedAt) / 1000);
        saveCallHistory({
          ...activeCall.v,
          duration: `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`,
          endedAt: Date.now(),
        });

        if (activeCall.v.platform === 'whatsapp' && activeCall.v.provider === 'wacalls') {
          // Real hangup: WaCalls sends WhatsApp's own terminate to the peer
          // and tears its media task down. A failure here (already gone, or
          // WaCalls briefly unreachable) is logged, never thrown at the user:
          // the local call screen closes either way.
          if (activeCall.v.callId) {
            try {
              await wacalls.endCall(activeCall.v.callId);
            } catch (e) {
              console.warn(`[WaCalls] hangup for callId=${activeCall.v.callId} failed: ${e.message}`);
            }
          }
          stopWacallsStatePoll();
        } else if (activeCall.v.platform === 'whatsapp') {
          // No server-side hangup call for Green API - the frontend calls
          // gaClient.hangUp() directly (client-side), same as placing the
          // call itself.
        } else if (activeCall.v.platform === 'telegram') {
          await proxyToTgCalls('/hangup', 'POST').catch(() => {});
          closeTgCallsPipes();
          stopTgCallsStatePoll();
        }

        broadcastMediaEvent({ type: 'call_state', state: 'ended' });
        activeCall.v = null;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ended' }));
    }
  }

  // -------------------------------------------------------------
  // Keep-alive ping toggle (test-mode only) - see the comment above the
  // GITHUB_REPO constant for why this drives a GitHub Actions workflow
  // instead of an internal timer.
  // -------------------------------------------------------------
  if (pathname === '/api/keepalive/status' && req.method === 'GET') {
    try {
      const wf = await githubApi(`/actions/workflows/${KEEPALIVE_WORKFLOW_ID}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ enabled: wf.state === 'active' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === '/api/keepalive/toggle' && req.method === 'POST') {
    const body = await parseBody(req);
    const enabled = !!body.enabled;
    try {
      await githubApi(`/actions/workflows/${KEEPALIVE_WORKFLOW_ID}/${enabled ? 'enable' : 'disable'}`, 'PUT');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ enabled }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === '/api/keepalive/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ts: Date.now() }));
  }

  // -------------------------------------------------------------
  // Route to existing /api/*.js handlers
  // -------------------------------------------------------------
  if (pathname.startsWith('/api/')) {
    const routeName = pathname.replace('/api/', '').split('?')[0];
    const handlerFile = path.join(__dirname, 'api', `${routeName}.js`);

    if (fs.existsSync(handlerFile)) {
      try {
        const mod = await import(handlerFile);
        const handler = mod.default || mod;

        // Mock req/res for Vercel-style handlers
        req.query = Object.fromEntries(parsedUrl.searchParams);
        req.body = await parseBody(req);

        let resSent = false;
        const mockRes = {
          status(code) {
            res.statusCode = code;
            return this;
          },
          setHeader(k, v) {
            res.setHeader(k, v);
            return this;
          },
          json(obj) {
            if (resSent) return;
            resSent = true;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(obj));
          },
          send(data) {
            if (resSent) return;
            resSent = true;
            res.end(data);
          },
        };

        return await handler(req, mockRes);
      } catch (err) {
        console.error(`[API Error] ${pathname}:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }
  }

  // -------------------------------------------------------------
  // Serve Static Files
  // -------------------------------------------------------------
  let reqPath = pathname === '/' ? '/index.html' : pathname;
  let filePath = path.join(__dirname, reqPath);

  // If path doesn't exist, try index.html (SPA fallback)
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(__dirname, 'index.html');
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// -------------------------------------------------------------
// Realtime RVC voice conversion for Lucy 2.5 calls
// -------------------------------------------------------------
// Lucy 2.5 (decart/lucy-2-5/realtime) is a video-to-video model: it supplies
// the live avatar and no voice. The audio that goes out with that avatar is
// the live audio already paired with the avatar pipeline - the mic track the
// frontend streams up here as channel 0x02 (see SocialCallMediaAdapter in
// app.src.js). When a conversion session is running, that stream is piped
// through w-okada/voice-changer + an RVC model instead of going straight to
// the call, chunk after chunk, for the whole call - no files, no sentences,
// no TTS.
//
// Where the converted audio goes depends only on how each platform carries
// its outgoing media:
//   * Telegram - the call's outgoing audio is server-side: it is written to
//     the same /tmp/tgcalls_audio.pcm FIFO tgcalls_bridge reads from, so the
//     converted voice is the audio track that travels with the Lucy video.
//   * WhatsApp - the call is browser-side WebRTC (Green API calls SDK), so
//     the converted PCM is sent back to the browser as channel 0x06
//     (MEDIA_CH.RVC_AUDIO_OUT) and the frontend makes it the outgoing audio
//     track there. This is the Green API path. On WaCalls the converted
//     audio is inserted into the browser's own outgoing "pcm" data channel
//     (see WaCallsMediaLeg in app.src.js), so it reaches WhatsApp the same
//     way by a different route - one conversion, two transports.
// Incoming (caller) audio is untouched by all of this.
//
// If the converter is down or misconfigured the original audio is forwarded
// unchanged and the status says so - a call must never go silent, and the UI
// must never claim a voice is being converted when it isn't.
function vcSamplesFrom(payload) {
  // Channel 0x02 carries raw little-endian int16. The payload is a
  // subarray (offset by the 1-byte channel tag) so it is frequently
  // unaligned for a typed-array view - read it sample by sample instead.
  const n = Math.floor(payload.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = payload.readInt16LE(i * 2);
  return out;
}

function vcSamplesToBuffer(samples) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

// Where outgoing call audio went BEFORE voice conversion existed (kept
// verbatim - this is the fallback path and the non-converted path).
function writeRawCallAudio(payload) {
  if (activeCall.v?.platform === 'telegram' && tgCallsAudioStream && !tgCallsAudioStream.destroyed) {
    tgCallsAudioStream.write(payload);
  }
}

function broadcastConvertedAudio(samples) {
  if (!samples || !samples.length) return;
  const payload = vcSamplesToBuffer(samples);
  // 0x06 = this call's own outgoing audio after RVC conversion. Uses the
  // same [channel][4-byte BE length][payload] framing as the peer-media
  // channels (0x03/0x04), rather than a bespoke one-byte-tag format, so the
  // browser has exactly one binary frame parser for this socket.
  const tagged = Buffer.alloc(5 + payload.byteLength);
  tagged[0] = MEDIA_CH.RVC_AUDIO_OUT;
  tagged.writeUInt32BE(payload.byteLength, 1);
  payload.copy(tagged, 5);
  const uid = currentUserId();
  if (!uid) return;
  for (const ws of mediaClients) {
    if (ws.readyState === WebSocket.OPEN && ws.userId === uid) {
      try { ws.send(tagged); } catch (e) {}
    }
  }
}

function handleConvertedAudio(samples) {
  const platform = voiceChanger.session?.platform || activeCall.v?.platform;
  if (platform === 'telegram') {
    writeRawCallAudio(vcSamplesToBuffer(samples));
    return;
  }
  // WhatsApp: the call's WebRTC audio lives in the browser, so hand the
  // converted audio back for the outgoing track (see app.src.js).
  broadcastConvertedAudio(samples);
}

function broadcastVoiceStatus() {
  broadcastMediaEvent({ type: 'vc_status', ...voiceChanger.status() });
}

async function startVoiceConversion({ platform, modelSlot } = {}) {
  try {
    if (modelSlot !== undefined && modelSlot !== null && Number(modelSlot) !== VC_CONFIG.modelSlot) {
      VC_CONFIG.modelSlot = Number(modelSlot);
      await voiceChanger.selectModel(VC_CONFIG.modelSlot);
    }
    await voiceChanger.startSession({
      platform: platform || activeCall.v?.platform || null,
      onConverted: handleConvertedAudio,
    });
  } catch (e) {
    // Never let a converter problem break the call: keep the session (it
    // falls back to pass-through) and report the reason.
    voiceChanger.lastError = e.message;
    voiceChanger.mode = 'bypass';
    console.warn('[VoiceChanger] start failed, falling back to pass-through:', e.message);
  }
  broadcastVoiceStatus();
  return voiceChanger.status();
}

function stopVoiceConversion() {
  voiceChanger.stopSession();
  broadcastVoiceStatus();
  return voiceChanger.status();
}

// -------------------------------------------------------------
// WebSocket Server for Lucy 2.5 / Anam Outgoing Video + Mic Media Bridge
// -------------------------------------------------------------
//
// Tagged binary frames on this socket (one framing rule for every direction,
// shared with the browser's parser in app.src.js):
//
//   0x01  browser -> server  one JPEG frame of live avatar video
//   0x02  browser -> server  16 kHz mono s16le PCM (the audio that goes out
//                            with the avatar)
//   0x03  server -> browser  peer PCM (peer media returned over this socket -
//   0x04  server -> browser  peer H.264 access units      used by engines that
//                            keep their media in the backend)
//   0x06  server -> browser  this call's outgoing audio after RVC conversion
//
// WaCalls uses NONE of the server-side media channels: its call media is
// WebRTC data channels between the browser and the WaCalls server ("pcm" for
// 16 kHz mono s16le both ways, "vp8" for encoded H.264 access units both
// ways), fed by WaCallsMediaLeg in app.src.js. 0x01/0x02 are still what the
// browser sends here, because this socket is also the Telegram path and the
// RVC feed; 0x06 is still how converted audio gets back to the browser.
// -------------------------------------------------------------
const MEDIA_CH = {
  VIDEO_IN: 0x01,
  AUDIO_IN: 0x02,
  PEER_PCM: 0x03,
  PEER_H264: 0x04,
  RVC_AUDIO_OUT: 0x06,
};

const wss = new WebSocketServer({ server, path: '/api/social-call/media' });
const mediaClients = new Set();

function broadcastMediaEvent(msg) {
  const payload = typeof msg === 'string' ? msg : JSON.stringify(msg);
  const uid = currentUserId();
  if (!uid) return; // never fan out to everyone: with no owner, nobody gets it
  for (const ws of mediaClients) {
    if (ws.readyState === WebSocket.OPEN && ws.userId === uid) {
      ws.send(payload);
    }
  }
}

// Binary counterpart of broadcastMediaEvent: peer media returned THROUGH this
// socket (channel 0x03 PCM, 0x04 H.264) is forwarded to the browser in the
// same tagged frame format it already sends upward, so one framing rule covers
// both directions. The WaCalls engine does not use this - its peer audio and
// video arrive on the browser's own WebRTC data channels - but the framing and
// the browser-side parser stay, because the RVC return path (0x06) shares them.
function broadcastMediaBinary(buffer) {
  const uid = currentUserId();
  if (!uid) return;
  for (const ws of mediaClients) {
    if (ws.readyState === WebSocket.OPEN && ws.userId === uid) {
      ws.send(buffer);
    }
  }
}

// Forward WhatsApp call events to connected WebSocket clients
// No persistent WhatsApp connection/event emitter to listen to anymore -
// greenapi_bridge.mjs is stateless, per-user, and per-request (see above).
// The frontend's existing wa_status/wa_qr polling already re-fetches
// status on its own timer, which is how the WhatsApp connect screen
// learns about changes now.

wss.on('connection', async (ws, req) => {
  let uid = null;
  try {
    const token = new URL(req.url, 'http://x').searchParams.get('token') || '';
    uid = await authedApprovedUserId(token);
  } catch (e) { uid = null; }
  if (!uid) { try { ws.close(4401, 'unauthorized'); } catch (e) {} return; }
  ws.userId = uid;
  // Everything this socket triggers runs as its user.
  userContext.enterWith({ userId: uid });
  mediaClients.add(ws);
  console.log('[MediaWS] Client connected. Total:', mediaClients.size);

  // Send current active call state if any
  if (activeCall.v) {
    ws.send(JSON.stringify({ type: 'call_state', state: activeCall.v.status, call: activeCall.v }));
  }

  ws.on('message', (data, isBinary) => userContext.run({ userId: uid }, () => {
    if (isBinary) {
      // Binary frame from Lucy 2.5 canvas / video stream or mic PCM
      // First byte can be channel identifier: 0x01 = Lucy video frame, 0x02 = Mic audio
      const channel = data[0];
      const payload = data.subarray(1);

      if (channel === 0x01) {
        // Lucy 2.5 / Avatar outgoing video frame (JPEG blob, ~15fps - see
        // SocialCallMediaAdapter.startStreaming in app.src.js). Previously
        // received and silently dropped here for every call, WhatsApp and
        // Telegram alike - nothing ever consumed these bytes. For a real
        // Telegram P2P call, tgcalls_bridge's set_media() reads outgoing
        // video from TGCALLS_VIDEO_PIPE as a concatenated-JPEG (MJPEG)
        // stream, decoded by ffmpeg on that side.
        if (activeCall.v?.platform === 'telegram' && tgCallsVideoStream && !tgCallsVideoStream.destroyed) {
          tgCallsVideoStream.write(payload);
        }
        // WaCalls does NOT consume these bytes on the server side: its
        // video-carrying leg is a WebRTC data channel straight from the
        // browser to the WaCalls server ("vp8"), fed by WaCallsMediaLeg in
        // app.src.js from the same avatar canvas - which is also why Anam and
        // Lucy 2.5 both work with no provider branch on the avatar side.
        // This socket keeps serving Telegram (above) and the RVC return path
        // (0x06) unchanged.
      } else if (channel === 0x02) {
        // Microphone PCM audio chunk - the live audio paired with the Lucy
        // 2.5 avatar pipeline (raw s16le, 16kHz mono - see
        // tgcalls_bridge's AudioDescription: sample_rate 16000, 1 channel).
        if (voiceChanger.session) {
          // Real-time RVC conversion is running: it takes it from here and
          // calls back through handleConvertedAudio() for each converted
          // chunk (bypassing untouched if the converter is unhealthy).
          voiceChanger.push(vcSamplesFrom(payload));
        } else {
          writeRawCallAudio(payload);
        }
        // As above: for WaCalls this PCM goes out through the browser's own
        // "pcm" data channel to the WaCalls server (raw 16 kHz mono s16le,
        // exactly what WaCalls' bridge hands its own audio engine), not
        // through this socket.
      }
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'call_ready') {
          if (activeCall.v) {
            markConnected(activeCall.v);
            broadcastMediaEvent({ type: 'call_state', state: 'connected', call: activeCall.v });
          }
        } else if (msg.type === 'vc_start') {
          // Starts real-time conversion of the outgoing Lucy audio for this
          // call. Only ever sent for the Lucy 2.5 source - the app never
          // asks for it on the Anam avatar path.
          startVoiceConversion({ platform: msg.platform, modelSlot: msg.modelSlot });
        } else if (msg.type === 'vc_stop') {
          stopVoiceConversion();
        } else if (msg.type === 'vc_status') {
          ws.send(JSON.stringify({ type: 'vc_status', ...voiceChanger.status() }));
        }
      } catch (e) {}
    }
  }));

  ws.on('close', () => userContext.run({ userId: uid }, () => {
    mediaClients.delete(ws);
    // Nothing left to convert if the last browser is gone and no call is up.
    // Deliberately delayed: a socket that is merely reconnecting mid-call
    // must not lose the conversion it is using.
    setTimeout(() => {
      if (![...mediaClients].some((c) => c.userId === uid) && !activeCall.v && voiceChanger.session) {
        console.log('[MediaWS] last client gone with no active call - stopping voice conversion');
        voiceChanger.stopSession();
      }
    }, 2000);
  }));
});

// Start services
server.listen(PORT, HOST, () => {
  console.log(`Live Call server running at http://${HOST}:${PORT}`);
  startTelegramBridge();
  startTgCallsBridge();
  // No global WhatsApp init needed for GREEN-API anymore - greenapi_bridge.mjs
  // is stateless and per-user (see requireGreenApiCreds above). WaCalls is a
  // long-lived external service, so what is started here is the subscription
  // to its event stream (incoming calls, accept/reject, end, media ready) -
  // nothing is spawned, and an unconfigured instance only logs a warning.
  wacalls.startEventStream();
  // Opt-in (VOICE_CHANGER_AUTOSTART=1) - see server/voicechanger/setup.sh.
  startVoiceChangerProcess();
});
