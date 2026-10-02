import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { getProviderKey } from '../lib/keys.js';

// POST {app} -> a short-lived Fal realtime token (plain text body, not JSON -
// the fal client's tokenProvider calls response.text() on whatever this
// returns). Mirrors the pattern documented at
// fal.ai/docs/documentation/model-apis/inference/real-time: the token is
// minted server-side against https://rest.fal.ai/tokens/realtime using the
// caller's OWN Fal key (never a shared server key), scoped to the one app
// they're connecting to and expiring quickly.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const { app, provider } = req.body || {};

  // Decart (native): mint a short-lived client token (ek_...) with the caller's OWN
  // Decart key. The permanent key never reaches the browser. Kept in this file
  // because Vercel Hobby caps a project at 12 functions.
  if (provider === 'decart') {
    const decartKey = await getProviderKey(supabase, userId, 'decart');
    if (!decartKey) return res.status(400).json({ error: 'Add your Decart API key in Profile > API first' });
    try {
      const r = await fetch('https://api.decart.ai/v1/client/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': decartKey },
        body: JSON.stringify({}),
      });
      const raw = await r.text();
      let data = null; try { data = JSON.parse(raw); } catch (e) { /* not json */ }
      const apiKey = data && (data.apiKey || data.api_key || data.token);
      if (!r.ok || !apiKey) {
        console.error(`[decart-token] ${r.status} from Decart: ${raw.slice(0, 300)}`);
        return res.status(r.ok ? 502 : r.status).json({ error: `Decart returned ${r.status}: ${(data && (data.error || data.message)) || raw.slice(0, 200) || 'no body'}` });
      }
      return res.status(200).json({ apiKey, expiresAt: data.expiresAt || data.expires_at || null });
    } catch (err) {
      return res.status(500).json({ error: err.message || String(err) });
    }
  }

  if (!app || typeof app !== 'string') return res.status(400).json({ error: 'Missing app' });

  const falKey = await getProviderKey(supabase, userId, 'fal');
  if (!falKey) return res.status(400).json({ error: 'Add your Fal API key in Profile > API first' });

  try {
    const resp = await fetch('https://rest.fal.ai/tokens/realtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Key ${falKey}` },
      // Fal's own docs show `allowed_apps: [app]`, but the live endpoint's
      // actual validation (confirmed via its own 422 response) wants a
      // single `app` string field instead - `allowed_apps` doesn't exist on
      // this schema at all. Sending both so this keeps working even if a
      // future Fal update reintroduces allowed_apps.
      body: JSON.stringify({ app, allowed_apps: [app], duration: 120 }),
    });
    const raw = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { /* truly plain text, not JSON at all */ }

    // Fal's actual success shape is a JSON-encoded string (the raw body is
    // `"eyJ...`" with real quote characters) - JSON.parse succeeds and hands
    // back a plain JS string, not an object, so `.token` never applies here.
    // Still also handle {token: "..."} and truly unquoted plain text, in
    // case Fal's response shape varies.
    let token = null;
    if (typeof parsed === 'string') {
      token = parsed;
    } else if (parsed && typeof parsed === 'object' && parsed.token) {
      token = parsed.token;
    } else if (resp.ok && parsed === null) {
      token = raw;
    }
    const data = (parsed && typeof parsed === 'object') ? parsed : null;

    if (!resp.ok || !token) {
      // Masked key fingerprint (never the key itself) so a 401 can be
      // cross-checked against the exact key saved in Profile > API without
      // ever putting the plaintext key in a log or response.
      const keyFingerprint = falKey.length > 8
        ? `${falKey.slice(0, 4)}…${falKey.slice(-4)} (${falKey.length} chars)`
        : `(${falKey.length} chars)`;
      const detail = (data && (data.error || data.message || data.detail)) || raw || 'no response body';
      const detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail);
      console.error(`[fal-realtime-token] ${resp.status} from Fal. key=${keyFingerprint} app=${app} detail=${detailStr}`);
      // resp.ok being true but data.token missing means Fal replied 2xx with
      // an unexpected body shape - that's still an error on our end and must
      // never be forwarded as a 2xx, or the browser's `!r.ok` check will miss
      // it entirely and hand the error JSON to the fal client as if it were
      // a real token (silent, unexplained connection failure downstream).
      const statusToSend = resp.ok ? 502 : (resp.status || 500);
      return res.status(statusToSend).json({
        error: `Fal returned ${resp.status}: ${detailStr}`,
        keyFingerprint,
        app,
      });
    }
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(token);
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
