// Stand-ins for the two browser modules the app imports from esm.sh.
// Kept as plain JS strings so the e2e test can serve them to the page.

export const FAKE_SUPABASE = `
const db = window.__db = {
  user_approvals: [{ user_id: 'alice', approved: true }],
  video_call_settings: [{ user_id: 'alice', system_prompt: 'Call my friend and catch up', anam_avatar_id: 'av1',
    anam_avatar_name: 'Test avatar', anam_voice_id: 'v1', anam_voice_name: 'Test voice', display_name: 'Alice',
    country: 'NG', language: 'en', theme: 'dark' }],
  contacts: [{ id: 'c1', user_id: 'alice', name: 'Callee Chris', cc: '234', number: '9077848577', target: '2349077848577' }],
  video_call_history: [], video_call_chats: [], avatar_memory: [], push_subscriptions: [],
};
let seq = 0;
function from(table) {
  const q = { f: [], op: 'select', payload: null, single: false };
  const rows = () => (db[table] = db[table] || []);
  const match = (r) => q.f.every(([c, v]) => r[c] === v);
  const run = async () => {
    const t = rows();
    if (q.op === 'insert' || q.op === 'upsert') {
      const list = Array.isArray(q.payload) ? q.payload : [q.payload];
      const out = list.map((p) => {
        let existing = null;
        if (q.op === 'upsert') existing = t.find((r) => (p.user_id && p.target && r.user_id === p.user_id && r.target === p.target) || (!p.target && p.user_id && r.user_id === p.user_id && table === 'video_call_settings'));
        if (existing) { Object.assign(existing, p); return existing; }
        const row = { id: p.id || ('r' + (++seq)), ...p }; t.push(row); return row;
      });
      return { data: q.single ? out[0] : out, error: null };
    }
    if (q.op === 'update') { const hit = t.filter(match); hit.forEach((r) => Object.assign(r, q.payload)); return { data: q.single ? hit[0] || null : hit, error: null }; }
    if (q.op === 'delete') { db[table] = t.filter((r) => !match(r)); return { data: null, error: null }; }
    const hit = t.filter(match);
    return { data: q.single ? (hit[0] || null) : hit, error: null };
  };
  const api = new Proxy({}, { get(_, k) {
    if (k === 'then') return (res, rej) => run().then(res, rej);
    if (k === 'select') return () => api;
    if (k === 'insert' || k === 'upsert' || k === 'update') return (p) => { q.op = k; q.payload = p; return api; };
    if (k === 'delete') return () => { q.op = 'delete'; return api; };
    if (k === 'eq') return (c, v) => { q.f.push([c, v]); return api; };
    if (k === 'single' || k === 'maybeSingle') return () => { q.single = true; return api; };
    return () => api; // order, limit, in, gte, ...
  } });
  return api;
}
const session = { access_token: 'test-token:alice', user: { id: 'alice', email: 'alice@test.dev', app_metadata: { provider: 'email' }, identities: [{ provider: 'email' }] } };
export function createClient() {
  return {
    from,
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: (cb) => { setTimeout(() => cb('SIGNED_IN', session), 0); return { data: { subscription: { unsubscribe() {} } } }; },
      signOut: async () => ({}), signInWithOAuth: async () => ({}), getUser: async () => ({ data: { user: session.user } }),
    },
    storage: { from: () => ({ upload: async () => ({ data: {}, error: null }), getPublicUrl: () => ({ data: { publicUrl: '' } }) }) },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel() {},
  };
}
`;

// A fake Anam SDK that behaves like the real one where it matters for this app:
//  - enforces a concurrent-session limit (free plan = 1), including a release lag
//  - streams a bright animated picture + a tone, so "blank video" is detectable
//  - records everything the app does (attempts, audio passed in, stops)
export const FAKE_ANAM = `
export const AnamEvent = {
  VIDEO_PLAY_STARTED: 'VIDEO_PLAY_STARTED', CONNECTION_CLOSED: 'CONNECTION_CLOSED', SERVER_WARNING: 'SERVER_WARNING',
  MESSAGE_HISTORY_UPDATED: 'MESSAGE_HISTORY_UPDATED', SESSION_READY: 'SESSION_READY', MESSAGE_STREAM_EVENT_RECEIVED: 'MESSAGE_STREAM_EVENT_RECEIVED',
};
const W = window;
const L = W.__anamLog = W.__anamLog || { attempts: [], live: 0, maxLive: 0, started: 0, stopped: 0, rejected: 0, muteLog: [], msgs: [] };
W.__anamCfg = W.__anamCfg || { limit: 1, startDelayMs: 1200, releaseLagMs: 0, failAttempts: [] };
if (W.__anamCfg.preLive && !W.__preLiveApplied) { W.__preLiveApplied = true; L.live = W.__anamCfg.preLive; } // a session leaked by an earlier call
W.__anamReleaseAll = () => { const n = L.live; L.live = 0; return n; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient(token) {
  const handlers = {}; let mine = false; let stream = null; let id = null; let raf = null; let gainNode = null; let inAudio = null;
  const emit = (ev, ...a) => (handlers[ev] || []).forEach((f) => { try { f(...a); } catch (e) { console.error(e); } });
  const release = async () => {
    if (!mine) return; mine = false; L.stopped++;
    const lag = W.__anamCfg.releaseLagMs || 0; if (lag) await sleep(lag);
    L.live = Math.max(0, L.live - 1);
  };
  return {
    addListener(ev, cb) { (handlers[ev] = handlers[ev] || []).push(cb); },
    getActiveSessionId() { return id; },
    async streamToVideoElement(elementId, userAudio) {
      const cfg = W.__anamCfg; const n = L.attempts.length + 1;
      L.attempts.push({ n, t: Date.now(), userAudio: !!userAudio, elementId, live: L.live }); inAudio = userAudio || null;
      if (L.live >= cfg.limit) { L.rejected++; throw new Error('Concurrency limit reached, please upgrade your plan'); }
      L.live++; mine = true; L.started++; L.maxLive = Math.max(L.maxLive, L.live); id = 'sess-' + n;
      await sleep(cfg.startDelayMs);
      if (cfg.failAttempts.includes(n)) { await release(); throw new Error('Simulated Anam failure on attempt ' + n); }
      // A bright, moving picture (never black) + a tone for audio.
      const c = document.createElement('canvas'); c.width = 320; c.height = 480; const x = c.getContext('2d');
      let t0 = 0; const draw = () => { t0 += 1; x.fillStyle = '#ff7a00'; x.fillRect(0, 0, 320, 480); x.fillStyle = '#00d0b0'; x.beginPath(); x.arc(160 + Math.sin(t0 / 8) * 70, 240, 90, 0, 7); x.fill(); raf = requestAnimationFrame(draw); };
      draw();
      const ac = new (W.AudioContext || W.webkitAudioContext)(); const dest = ac.createMediaStreamDestination();
      const osc = ac.createOscillator(); osc.frequency.value = 440; const g = ac.createGain(); g.gain.value = 0; gainNode = g; osc.connect(g).connect(dest); osc.start(); // silent until it is told the call is connected, like the real persona
      stream = new MediaStream([...c.captureStream(15).getVideoTracks(), ...dest.stream.getAudioTracks()]);
      const el = document.getElementById(elementId); el.srcObject = stream; el.muted = true;
      try { await el.play(); } catch (e) {}
      emit(AnamEvent.VIDEO_PLAY_STARTED); emit(AnamEvent.SESSION_READY);
      setTimeout(() => emit(AnamEvent.MESSAGE_HISTORY_UPDATED, [
        { id: 'm1', role: 'persona', content: 'Hello Chris, it is Alice\\'s assistant. How are you today?' },
        { id: 'm2', role: 'user', content: 'I am fine, just got back from work.' },
        { id: 'm3', role: 'persona', content: 'Glad to hear it. Alice wanted to check on dinner on Friday.' },
      ]), 2500);
    },
    async stopStreaming() { cancelAnimationFrame(raf); if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; await release(); },
    muteInputAudio() { L.muteLog.push({ t: Date.now(), m: true, trackEnabled: inAudio ? inAudio.getAudioTracks().every((t) => t.enabled) : null }); if (inAudio) inAudio.getAudioTracks().forEach((t) => { t.enabled = false; }); },
    unmuteInputAudio() { L.muteLog.push({ t: Date.now(), m: false }); if (inAudio) inAudio.getAudioTracks().forEach((t) => { t.enabled = true; }); },
    sendUserMessage(msg) { L.msgs.push({ t: Date.now(), msg: String(msg).slice(0, 160), audioEnabled: inAudio ? inAudio.getAudioTracks().every((t) => t.enabled) : null }); if (gainNode) gainNode.gain.value = 0.5; /* the persona greets */ },
    talk() {}, interruptPersona() {},
  };
}
`;
