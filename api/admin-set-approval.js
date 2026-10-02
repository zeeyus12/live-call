import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!serviceKey || !adminEmail) return res.status(500).json({ error: 'Server not configured' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const supabase = createClient('https://ewgtpxomgkpbmfyddypw.supabase.co', serviceKey);

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid session' });
  const signedInEmail = (userData.user.email || '').trim().toLowerCase();
  if (signedInEmail !== adminEmail.trim().toLowerCase()) {
    return res.status(403).json({ error: `Not authorized — signed in as "${userData.user.email}", expected admin email to match server's ADMIN_EMAIL` });
  }

  const { targetUserId, approved, whatsapp } = req.body || {};
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
  if (typeof approved !== 'boolean' && !whatsapp) {
    return res.status(400).json({ error: 'Provide approved (boolean) and/or whatsapp: { action }' });
  }

  if (typeof approved === 'boolean') {
    const { error } = await supabase.from('user_approvals').update({ approved }).eq('user_id', targetUserId);
    if (error) return res.status(500).json({ error: error.message });
  }
  if (whatsapp) {
    // WhatsApp connect lock. Actions:
    //   open  { minutes }  unlock and ADD that many minutes to what is left
    //   lock               lock again (unused minutes are kept)
    //   pro   { on }       switch Pro on/off (unlimited while on)
    const { data: existing, error: readErr } = await supabase
      .from('whatsapp_access').select('*').eq('user_id', targetUserId).maybeSingle();
    if (readErr) return res.status(500).json({ error: readErr.message });
    const row = { user_id: targetUserId, updated_at: new Date().toISOString() };

    if (whatsapp.action === 'open') {
      const minutes = Number(whatsapp.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 100000) {
        return res.status(400).json({ error: 'minutes must be a number greater than 0' });
      }
      row.unlocked = true;
      row.minutes_granted = Number(existing?.minutes_granted || 0) + minutes;
    } else if (whatsapp.action === 'lock') {
      row.unlocked = false;
    } else if (whatsapp.action === 'pro') {
      row.plan = whatsapp.on ? 'pro' : 'free';
      row.pro_until = null;
    } else {
      return res.status(400).json({ error: 'Unknown whatsapp action' });
    }
    const { error } = await supabase.from('whatsapp_access').upsert(row);
    if (error) return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ ok: true });
}
