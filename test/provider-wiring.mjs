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
// Telegram coming soon + bridge crash loop stopped
assert.ok(srv.includes("ENABLE_TELEGRAM_BRIDGE !== '1'"));
assert.ok(html.includes('id="telegramAccountBadge">Coming soon') && html.includes('id="choiceTelegramSubtitle">Coming soon'));
// Anam: pinned SDK, single loader, retry + preload
assert.ok(!app.includes('@anam-ai/js-sdk@latest'));
assert.equal((app.match(/@anam-ai\/js-sdk@4\.27\.1/g) || []).length, 1);
assert.ok(app.includes('mintAnamSession') && app.includes("loadAnamSdk().catch"));
// Regression: Decart's model.fps is ALREADY a constraint object ({ideal,max}).
// Wrapping it as { ideal: model.fps } made WebKit throw "The provided value is non-finite".
assert.ok(!/frameRate:\s*\{\s*ideal:\s*model\.fps\s*\}/.test(app), 'do not wrap model.fps in another { ideal }');
assert.ok(app.includes("typeof model.fps === 'number'"));
console.log('provider-wiring: all checks passed');
