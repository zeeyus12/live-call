import { createClient } from '@supabase/supabase-js';
import { evaluateAccess } from '../lib/whatsappAccess.js';

export default async function handler(req, res) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!serviceKey || !adminEmail) return res.status(500).json({ error: 'Server not configured (SUPABASE_SERVICE_ROLE_KEY / ADMIN_EMAIL missing)' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const supabase = createClient('https://ewgtpxomgkpbmfyddypw.supabase.co', serviceKey);

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid session' });
  const signedInEmail = (userData.user.email || '').trim().toLowerCase();
  if (signedInEmail !== adminEmail.trim().toLowerCase()) {
    return res.status(403).json({ error: `Not authorized — signed in as "${userData.user.email}", expected admin email to match server's ADMIN_EMAIL` });
  }

  const { data, error } = await supabase
    .from('user_approvals')
    .select('user_id, email, approved, created_at')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // WhatsApp access per user (sql/011). If the table has not been created yet
  // the page still lists users; every user just shows as locked.
  const { data: accessRows, error: accessErr } = await supabase
    .from('whatsapp_access')
    .select('user_id, unlocked, minutes_granted, minutes_used, plan, pro_until');
  const accessByUser = Object.fromEntries((accessRows || []).map(r => [r.user_id, r]));
  const users = data.map(u => ({
    ...u,
    whatsapp: evaluateAccess(accessByUser[u.user_id], { isAdmin: false }),
  }));

  return res.status(200).json({ users, whatsappTableMissing: !!accessErr });
}
