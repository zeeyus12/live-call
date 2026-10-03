import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { getProviderKey } from '../lib/keys.js';
import { buildSystemPrompt } from '../lib/anamPrompt.js';

// GET    ?resource=avatars (default) | voices  -> list the caller's Anam avatars/voices
// POST   body.action:
//   'session'        {avatarId, voiceId?, systemPrompt}      -> mint a session token
//   'upload-avatar'  {imageUrl, displayName}                 -> create a custom avatar from
//                                                                a photo already hosted (client
//                                                                uploads to Supabase Storage first)
//   'voice-upload-url' {}                                    -> get a presigned URL for a raw
//                                                                audio upload (client PUTs the
//                                                                file bytes there directly)
//   'create-voice'   {audioKey, displayName}                 -> finish cloning after the PUT
// DELETE ?type=avatar|voice&id=...                           -> hard-delete a custom avatar/voice
//
// One file (not four+) to stay under Vercel Hobby's 12-function cap. The Anam key is
// looked up server-side from the user's own encrypted Vault secret - never trusted from
// a client-sent header, so it can never leak via network inspection on the client.
const DEFAULT_VOICE_ID = '6bfbe25a-979d-40f3-a92b-5394170af54b'; // Anam's published default (Cara)
const DEFAULT_LLM_ID = '0934d97d-0c3a-4f33-91b0-5e136a0ef466';  // GPT-4.1 Mini

async function parseJsonSafe(r) {
  const raw = await r.text();
  try { return { data: JSON.parse(raw), raw }; }
  catch { return { data: null, raw }; }
}

export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const apiKey = await getProviderKey(supabase, userId, 'anam');
  if (!apiKey) return res.status(400).json({ error: 'No Anam API key set. Add yours in Profile settings.' });
  const authHeaders = { Authorization: `Bearer ${apiKey}` };

  // ---------------------------------------------------------------- GET
  if (req.method === 'GET') {
    const resource = req.query.resource === 'voices' ? 'voices' : 'avatars';
    try {
      const r = await fetch(`https://api.anam.ai/v1/${resource}`, { headers: authHeaders });
      const { data, raw } = await parseJsonSafe(r);
      if (!data) {
        return res.status(502).json({
          error: `Anam returned a non-JSON response (status ${r.status}). This usually means your Anam API key is invalid. Raw response: ${raw.slice(0, 200)}`
        });
      }
      if (!r.ok) return res.status(r.status).json({ error: data });
      const list = data.data || data[resource] || data || [];
      const items = (Array.isArray(list) ? list : []).map(a => ({
        id: a.id,
        name: a.displayName || a.name || a.id,
        preview_url: a.videoUrl || a.previewUrl || a.audioUrl || '',
      }));
      return res.status(200).json({ [resource]: items });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  }

  // --------------------------------------------------------------- POST
  if (req.method === 'POST') {
    const { action } = req.body || {};

    if (action === 'session') {
      const { avatarId, voiceId, systemPrompt } = req.body || {};
      if (!avatarId) return res.status(400).json({ error: 'avatarId is required' });
      try {
        // Prefetch: pull whatever's been learned about this person from past
        // calls (see /api/call-summary.js's sync step, and sql/008_avatar_memory.sql)
        // and fold it into this call's system prompt.
        const { data: memRow } = await supabase
          .from('avatar_memory')
          .select('facts')
          .eq('user_id', userId)
          .maybeSingle();
        const r = await fetch('https://api.anam.ai/v1/auth/session-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            personaConfig: {
              name: 'Persona',
              avatarId,
              voiceId: voiceId || DEFAULT_VOICE_ID,
              llmId: DEFAULT_LLM_ID,
              // Anam auto-generates its own opening greeting by default, unrelated to
              // systemPrompt - skipGreeting keeps it silent until the other side speaks
              // first, so its first reply is grounded in the brief.
              systemPrompt: buildSystemPrompt(systemPrompt, memRow?.facts || ''),
              skipGreeting: true,
            },
          }),
        });
        const { data, raw } = await parseJsonSafe(r);
        if (!data) {
          return res.status(502).json({
            error: `Anam returned a non-JSON response (status ${r.status}). This usually means your Anam API key is invalid. Raw response: ${raw.slice(0, 200)}`
          });
        }
        if (!r.ok) return res.status(r.status).json({ error: data });
        return res.status(200).json({ sessionToken: data.sessionToken });
      } catch (err) {
        return res.status(500).json({ error: String(err) });
      }
    }

    // Force-ends every running Anam session on this user's account (Anam's own
    // POST /v1/sessions/{id}/stop), so a call that ended never keeps counting
    // against the one-session limit while Anam waits for its idle timeout.
    if (action === 'stop-active') {
      try {
        const lr = await fetch('https://api.anam.ai/v1/sessions?active=true&perPage=100', { headers: authHeaders });
        const { data } = await parseJsonSafe(lr);
        if (!lr.ok) return res.status(lr.status).json({ error: data || 'Could not list sessions' });
        const list = (Array.isArray(data?.data) ? data.data : []).filter(x => x && x.id && !x.endTime);
        const results = await Promise.all(list.map(async (x) => {
          try { const sr = await fetch(`https://api.anam.ai/v1/sessions/${x.id}/stop`, { method: 'POST', headers: authHeaders }); return sr.ok || sr.status === 404; }
          catch (_) { return false; }
        }));
        return res.status(200).json({ found: list.length, stopped: results.filter(Boolean).length });
      } catch (err) {
        return res.status(500).json({ error: String(err) });
      }
    }

    if (action === 'upload-avatar') {
      const { imageUrl, displayName } = req.body || {};
      if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required' });
      try {
        const r = await fetch('https://api.anam.ai/v1/avatars', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ displayName: displayName || 'My avatar', imageUrl }),
        });
        const { data, raw } = await parseJsonSafe(r);
        if (!data) {
          return res.status(502).json({ error: `Anam returned a non-JSON response (status ${r.status}). Raw: ${raw.slice(0, 200)}` });
        }
        if (!r.ok) return res.status(r.status).json({ error: data });
        return res.status(200).json({ id: data.id, name: data.displayName || data.name || data.id });
      } catch (err) {
        return res.status(500).json({ error: String(err) });
      }
    }

    if (action === 'voice-upload-url') {
      const { filename, contentType, fileSize } = req.body || {};
      if (!filename || !contentType || !fileSize) return res.status(400).json({ error: 'filename, contentType, and fileSize are required' });
      try {
        const r = await fetch('https://api.anam.ai/v1/voices/presigned-upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ filename, contentType, fileSize }),
        });
        const { data, raw } = await parseJsonSafe(r);
        if (!data) {
          return res.status(502).json({ error: `Anam returned a non-JSON response (status ${r.status}). Raw: ${raw.slice(0, 200)}` });
        }
        if (!r.ok) return res.status(r.status).json({ error: data });
        return res.status(200).json({ uploadUrl: data.uploadUrl, audioKey: data.audioKey });
      } catch (err) {
        return res.status(500).json({ error: String(err) });
      }
    }

    if (action === 'create-voice') {
      const { audioKey, displayName } = req.body || {};
      if (!audioKey) return res.status(400).json({ error: 'audioKey is required' });
      try {
        const r = await fetch('https://api.anam.ai/v1/voices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          // Anam's voices endpoint wants "name", unlike avatars which use "displayName" -
          // sending both covers either naming convention their validator actually checks.
          body: JSON.stringify({ name: displayName || 'My voice', displayName: displayName || 'My voice', audioKey }),
        });
        const { data, raw } = await parseJsonSafe(r);
        if (!data) {
          return res.status(502).json({ error: `Anam returned a non-JSON response (status ${r.status}). Raw: ${raw.slice(0, 200)}` });
        }
        if (!r.ok) return res.status(r.status).json({ error: data });
        return res.status(200).json({ id: data.id, name: data.displayName || data.name || data.id });
      } catch (err) {
        return res.status(500).json({ error: String(err) });
      }
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  // ------------------------------------------------------------- DELETE
  if (req.method === 'DELETE') {
    const { type, id } = req.query;
    if (!id || (type !== 'avatar' && type !== 'voice')) {
      return res.status(400).json({ error: 'type=avatar|voice and id are required' });
    }
    const resource = type === 'avatar' ? 'avatars' : 'voices';
    const idField = type === 'avatar' ? 'avatarId' : 'voiceId';
    const del = () => fetch(`https://api.anam.ai/v1/${resource}/${id}?hard=true`, { method: 'DELETE', headers: authHeaders });
    const listIds = async () => {
      const lr = await fetch(`https://api.anam.ai/v1/${resource}`, { headers: authHeaders });
      const { data: ld } = await parseJsonSafe(lr);
      const list = Array.isArray(ld?.data) ? ld.data : (Array.isArray(ld?.[resource]) ? ld[resource] : (Array.isArray(ld) ? ld : []));
      return lr.ok ? list.map(x => x.id) : null;
    };
    // Anam sometimes deletes and still answers with an error: if it is gone, that is a success.
    const goneNow = async () => { try { const ids = await listIds(); return !!ids && !ids.includes(id); } catch (_) { return false; } };
    try {
      let r = await del();
      if (r.ok || r.status === 404) return res.status(200).json({ deleted: true });
      let { data } = await parseJsonSafe(r);

      // Anam refuses to hard-delete an avatar/voice that personas still use. Move those
      // personas to another one (or remove them if there is none), then retry once.
      const impacted = data?.impactedPersonaIds || data?.error?.impactedPersonaIds;
      if (Array.isArray(impacted) && impacted.length) {
        const ids = (await listIds().catch(() => null)) || [];
        const fallbackId = ids.find(x => x !== id) || null;
        for (const pid of impacted) {
          const pr = fallbackId
            ? await fetch(`https://api.anam.ai/v1/personas/${pid}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ [idField]: fallbackId }),
              })
            : await fetch(`https://api.anam.ai/v1/personas/${pid}`, { method: 'DELETE', headers: authHeaders });
          if (!pr.ok && pr.status !== 404) {
            if (await goneNow()) return res.status(200).json({ deleted: true });
            const { data: pd } = await parseJsonSafe(pr);
            return res.status(pr.status).json({ error: pd || `Could not move persona ${pid} (status ${pr.status})` });
          }
        }
        r = await del();
        if (r.ok || r.status === 404) return res.status(200).json({ deleted: true });
        ({ data } = await parseJsonSafe(r));
      }
      if (await goneNow()) return res.status(200).json({ deleted: true });
      return res.status(r.status).json({ error: data || `Delete failed (status ${r.status})` });
    } catch (err) {
      if (await goneNow()) return res.status(200).json({ deleted: true });
      return res.status(500).json({ error: String(err) });
    }
  }

  return res.status(405).json({ error: 'GET, POST, or DELETE only' });
}
