import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { getProviderKey, saveProviderKey } from '../lib/keys.js';
import { HUMANIZER_DOC, HUMANIZER_DOC_FILENAME } from '../lib/humanizerDoc.js';

const PROVIDERS = ['tavus', 'anam', 'fal', 'decart', 'greenapi'];

// Pushes the fixed persona reference doc into this user's own Anam Knowledge
// base, using their own key. Runs once per user (tracked via
// anam_knowledge_doc_pushed) right after their key is first saved, so it
// happens invisibly during onboarding - no Anam dashboard visit required.
// Anam's presigned-upload flow is the same 3-step pattern used for voice
// cloning: request a URL, PUT the bytes, confirm.
async function pushHumanizerDoc(supabase, userId, apiKey) {
  try {
    const { data: existing } = await supabase
      .from('video_call_settings')
      .select('anam_knowledge_doc_pushed')
      .eq('user_id', userId)
      .maybeSingle();
    if (existing?.anam_knowledge_doc_pushed) return; // already done for this user

    const authHeaders = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    const bytes = new TextEncoder().encode(HUMANIZER_DOC);

    // Knowledge documents live inside a group (folder) - create one to hold this doc.
    const groupResp = await fetch('https://api.anam.ai/v1/knowledge/groups', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'Call Persona Guide' }),
    });
    if (!groupResp.ok) return;
    const { id: folderId } = await groupResp.json();
    if (!folderId) return;

    const presignResp = await fetch(`https://api.anam.ai/v1/knowledge/groups/${folderId}/documents/presigned-upload`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        filename: HUMANIZER_DOC_FILENAME,
        contentType: 'text/plain',
        fileSize: bytes.byteLength,
      }),
    });
    if (!presignResp.ok) return; // non-fatal - key save should still succeed either way
    const { uploadUrl, documentId } = await presignResp.json();
    if (!uploadUrl || !documentId) return;

    const putResp = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: bytes,
    });
    if (!putResp.ok) return;

    const confirmResp = await fetch(`https://api.anam.ai/v1/knowledge/documents/${documentId}/confirm-upload`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ fileSize: bytes.byteLength }),
    });
    if (!confirmResp.ok) return;

    await supabase
      .from('video_call_settings')
      .upsert({ user_id: userId, anam_knowledge_doc_pushed: true, updated_at: new Date().toISOString() });
  } catch (err) {
    // Silent by design - this is a background enhancement, never block the
    // user's actual key save on it. Worth logging server-side if this becomes
    // a support question later.
    console.error('pushHumanizerDoc failed:', err);
  }
}

export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  if (req.method === 'GET' && req.query.balance === 'fal') {
    // fal.ai credit balance for the Home screen. Lives here (not in its own file)
    // to stay under Vercel Hobby's function cap. fal only serves this to an
    // ADMIN-scoped key, so a normal API-scope key comes back as needs_admin_key
    // and the client shows a hint instead of a number.
    const falKey = await getProviderKey(supabase, userId, 'fal');
    if (!falKey) return res.status(200).json({ reason: 'not_set' });
    try {
      const r = await fetch('https://api.fal.ai/v1/account/billing?expand=credits', {
        headers: { Authorization: `Key ${falKey}`, Accept: 'application/json' },
      });
      if (r.status === 401 || r.status === 403) return res.status(200).json({ reason: 'needs_admin_key' });
      if (!r.ok) return res.status(200).json({ reason: 'unavailable', status: r.status });
      const data = await r.json();
      const bal = data?.credits?.current_balance;
      if (typeof bal !== 'number') return res.status(200).json({ reason: 'unavailable' });
      return res.status(200).json({ balance: bal, currency: data.credits.currency || 'USD' });
    } catch (err) {
      return res.status(200).json({ reason: 'unavailable' });
    }
  }

  if (req.method === 'GET' && req.query.balance === 'anam') {
    // Anam has no balance/usage endpoint, so total this key's own session time for the
    // current (UTC) calendar month. Billing periods may start on another day.
    const anamKey = await getProviderKey(supabase, userId, 'anam');
    if (!anamKey) return res.status(200).json({ reason: 'not_set' });
    try {
      const monthStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
      let usedMs = 0, sessions = 0, desc = true;
      for (let page = 1; page <= 30; page++) {
        const r = await fetch(`https://api.anam.ai/v1/sessions?page=${page}&perPage=100`, {
          headers: { Authorization: `Bearer ${anamKey}`, Accept: 'application/json' },
        });
        if (r.status === 401 || r.status === 403) return res.status(200).json({ reason: 'invalid_key' });
        if (!r.ok) return res.status(200).json({ reason: 'unavailable', status: r.status });
        const body = await r.json();
        const rows = Array.isArray(body?.data) ? body.data : [];
        const startOf = (s) => Date.parse(s.startTime || s.createdAt || '');
        if (page === 1 && rows.length > 1) desc = startOf(rows[0]) >= startOf(rows[rows.length - 1]);
        for (const s of rows) {
          const start = startOf(s);
          if (!(start >= monthStart)) continue;
          sessions++;
          usedMs += typeof s.sessionLengthMs === 'number' ? s.sessionLengthMs
            : Math.max(0, (s.endTime ? Date.parse(s.endTime) : Date.now()) - start);
        }
        if (!body?.meta?.next || !rows.length) break;
        if (desc && startOf(rows[rows.length - 1]) < monthStart) break; // newest-first: the rest is older
      }
      return res.status(200).json({ usedMinutes: Math.round(usedMs / 6000) / 10, sessions });
    } catch (err) {
      return res.status(200).json({ reason: 'unavailable' });
    }
  }

  if (req.method === 'GET') {
    // Only ever reports whether a key is set, never the key itself - the
    // plaintext key never leaves the vault after the moment it's first saved.
    const status = {};
    for (const p of PROVIDERS) {
      const key = await getProviderKey(supabase, userId, p);
      status[p] = !!key;
    }
    const { data: settings } = await supabase
      .from('video_call_settings')
      .select('anam_key_locked')
      .eq('user_id', userId)
      .maybeSingle();
    status.anamKeyLocked = !!settings?.anam_key_locked;
    return res.status(200).json(status);
  }

  if (req.method === 'POST') {
    const { provider, key } = req.body || {};
    if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Unknown provider' });
    if (!key || !key.trim()) return res.status(400).json({ error: 'Empty key' });
    if (provider === 'anam') {
      const { data: settings } = await supabase
        .from('video_call_settings')
        .select('anam_key_locked')
        .eq('user_id', userId)
        .maybeSingle();
      if (settings?.anam_key_locked) {
        return res.status(403).json({ error: 'Your Anam key is locked and can\u2019t be changed. Contact support if you need this updated.' });
      }
    }
    const { error } = await saveProviderKey(supabase, userId, provider, key.trim());
    if (error) return res.status(500).json({ error: error.message || String(error) });
    if (provider === 'anam') await pushHumanizerDoc(supabase, userId, key.trim());
    return res.status(200).json({ saved: true });
  }

  return res.status(405).json({ error: 'GET or POST only' });
}
