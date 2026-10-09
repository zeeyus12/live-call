import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const keys = r('api/keys.js'), tok = r('api/fal-realtime-token.js'), srv = r('server.mjs');
const html = r('index.src.html'), app = r('app.src.js'), sql = r('sql/010_decart_key.sql');

// Decart key storage + token minting (client token, never the permanent key)
assert.ok(/PROVIDERS = \[[^\]]*'decart'/.test(keys));
assert.ok(sql.includes('decart_api_key_secret_id'));
assert.ok(tok.includes("provider === 'decart'") && tok.includes('api.decart.ai/v1/client/tokens'));
assert.ok(!/res\.[a-z]+\([^)]*decartKey/.test(tok), 'permanent Decart key must never be sent to the client');
// Vercel Hobby function cap: no new files under api/
import { readdirSync } from 'node:fs';
const fns = readdirSync(new URL('../api', import.meta.url)).filter(f => f.endsWith('.js'));
assert.ok(fns.length <= 12, `api/ has ${fns.length} functions (Vercel Hobby cap is 12)`);
// UI + client wiring
assert.ok(html.includes('id="decartApiKey"') && html.includes('id="saveDecartKey"') && html.includes('id="lucyProviderSelect"'));
assert.ok(app.includes("provider: 'decart'") && app.includes('@decartai/sdk@0.2.4') && app.includes("models.realtime('lucy-latest')"));
assert.ok(app.includes('lfDecart.disconnect()'));
assert.ok(app.includes("saveProviderKey('decart'"));
// Anam: pinned SDK, single loader, retry + preload
assert.ok(!app.includes('@anam-ai/js-sdk@latest'));
assert.equal((app.match(/@anam-ai\/js-sdk@4\.27\.1/g) || []).length, 1);
assert.ok(app.includes('mintAnamSession') && app.includes("loadAnamSdk().catch"));
// Regression: Decart's model.fps is ALREADY a constraint object ({ideal,max}).
// Wrapping it as { ideal: model.fps } made WebKit throw "The provided value is non-finite".
assert.ok(!/frameRate:\s*\{\s*ideal:\s*model\.fps\s*\}/.test(app), 'do not wrap model.fps in another { ideal }');
assert.ok(app.includes("typeof model.fps === 'number'"));
// Avatar calls: an Anam disconnect must not silently hang up the WhatsApp call,
// and media must flow before the avatar is up.
assert.ok(app.includes('recoverAvatar(why)') && app.includes('anamCloseReason'));
assert.ok(!/CONNECTION_CLOSED, \(\) => \{[^}]*endSocialCall\(\);\s*\}\);/.test(app), 'Anam close handler must not unconditionally end the call');
assert.ok(app.includes('startSilence()') && app.includes("this.ctx.fillStyle = '#101010'"));
// Avatar joins BEFORE the callee: it is started before the call is placed, not on answer.
assert.ok(!/onCallAnswered = \(\) => \{\s*startAvatar/.test(app), 'avatar must not be deferred to the answer');
assert.ok(app.includes('const avatarPromise = startAvatar().then(') && app.includes('isPlanLimitError(err)'));
assert.ok(app.includes('function startSocialCallTimer()'));
assert.ok(app.includes('showEndToast(lastEndReason)') && app.includes('browser_media_failed'));
assert.ok(app.includes('function trace(msg)') && app.includes('Copy details'));
// End-of-call reason is shown immediately (not behind the hangup request) and the hangup can't hang.
assert.ok(/trace\('call screen closed'\);\s*resetAvatarGate\(false\);\s*const waSummaryJob = captureWaAvatarCallForSummary\(\);\s*if \(lastEndReason\) \{ showEndToast/.test(app));
assert.ok(app.includes('sendWaCallSummary(waSummaryJob)') && app.includes('MESSAGE_HISTORY_UPDATED'));
assert.ok(app.includes('hc.abort(), 6000'));
assert.ok(app.includes('emptyStops'));
// Avatar video sent to the callee is read from the visible call-screen element, not the hidden prep one.
assert.ok(app.includes("if (this.source === 'anam') {") && app.includes('avatar frames are BLACK'));
// Avatar speech gate, H.264 guard, free test mode
assert.ok(app.includes('function scheduleAvatarGreeting()') && app.includes('GREETING_DELAY_MS = 5000') && app.includes('notifyCallConnected('));
assert.ok(app.includes('client.muteInputAudio()'));
assert.ok(app.includes('function avccToAnnexB(') && app.includes('function h264Format('));
assert.ok(app.includes('createTestAvatarClient') && app.includes("lc_test_avatar"));
console.log('provider-wiring: all checks passed');
