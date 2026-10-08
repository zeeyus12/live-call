import { createClient } from '@supabase/supabase-js';

// Usage leaderboard for the admin panel. No new tracking table needed - we
// already have per-user activity in video_call_history (one row per call)
// and video_call_chats (one row per chat, updated on every message), so this
// just aggregates those against user_approvals for email + join date.
// Same admin check as the other admin endpoints; reads go through the
// service role key, which bypasses RLS.
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

  const [usersRes, callsRes, chatsRes] = await Promise.all([
    supabase.from('user_approvals').select('user_id, email, created_at'),
    supabase.from('video_call_history').select('user_id, created_at'),
    supabase.from('video_call_chats').select('user_id, updated_at'),
  ]);
  if (usersRes.error) return res.status(500).json({ error: usersRes.error.message });
  if (callsRes.error) return res.status(500).json({ error: callsRes.error.message });
  if (chatsRes.error) return res.status(500).json({ error: chatsRes.error.message });

  // ?days=7|30|90 limits the counts to that window (lastActive stays all-time).
  const days = [7, 30, 90].includes(Number(req.query?.days)) ? Number(req.query.days) : 0;
  const since = days ? new Date(Date.now() - days * 864e5).toISOString() : null;
  const inRange = (ts) => !since || (ts && ts >= since);

  const stats = {};
  const series = new Map();
  for (let i = (days || 30) - 1; i >= 0; i--) series.set(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10), 0);
  const bump = (userId, field, ts) => {
    if (!userId) return;
    if (!stats[userId]) stats[userId] = { calls: 0, chats: 0, lastActive: null };
    if (inRange(ts)) stats[userId][field]++;
    if (ts && (!stats[userId].lastActive || ts > stats[userId].lastActive)) stats[userId].lastActive = ts;
  };
  (callsRes.data || []).forEach(c => {
    bump(c.user_id, 'calls', c.created_at);
    const day = String(c.created_at || '').slice(0, 10);
    if (inRange(c.created_at) && series.has(day)) series.set(day, series.get(day) + 1);
  });
  (chatsRes.data || []).forEach(c => bump(c.user_id, 'chats', c.updated_at));

  const rows = (usersRes.data || []).map(u => {
    const s = stats[u.user_id] || { calls: 0, chats: 0, lastActive: null };
    return {
      user_id: u.user_id,
      email: u.email,
      calls: s.calls,
      chats: s.chats,
      total: s.calls + s.chats,
      lastActive: s.lastActive,
      joined: u.created_at,
    };
  }).sort((a, b) => b.total - a.total);

  // Revenue comes from the payments table (sql/012). Until it exists the panel
  // says so instead of failing. Only the most recent currency is summed.
  const revenue = { currency: 'USD', total: 0, count: 0, payers: 0, allTime: 0, allTimeCount: 0, series: [], recent: [], tableMissing: false };
  const payRes = await supabase.from('payments').select('user_id, amount, currency, provider, paid_at').eq('status', 'paid').order('paid_at', { ascending: false }).limit(5000);
  if (payRes.error) revenue.tableMissing = true;
  else {
    const all = payRes.data || [];
    revenue.currency = all[0]?.currency || 'USD';
    const paid = all.filter(p => p.currency === revenue.currency);
    const ranged = paid.filter(p => inRange(p.paid_at));
    const byDay = new Map([...series.keys()].map(d => [d, 0]));
    for (const p of ranged) { const d = String(p.paid_at).slice(0, 10); if (byDay.has(d)) byDay.set(d, byDay.get(d) + Number(p.amount)); }
    const emailOf = Object.fromEntries((usersRes.data || []).map(u => [u.user_id, u.email]));
    Object.assign(revenue, {
      total: ranged.reduce((a, p) => a + Number(p.amount), 0), count: ranged.length,
      payers: new Set(ranged.map(p => p.user_id)).size,
      allTime: paid.reduce((a, p) => a + Number(p.amount), 0), allTimeCount: paid.length,
      series: [...byDay].map(([d, revenue]) => ({ d, revenue })),
      recent: paid.slice(0, 20).map(p => ({ email: emailOf[p.user_id] || null, amount: Number(p.amount), provider: p.provider, paid_at: p.paid_at })),
    });
  }

  const totals = {
    calls: rows.reduce((a, r) => a + r.calls, 0),
    chats: rows.reduce((a, r) => a + r.chats, 0),
    activeUsers: rows.filter(r => r.total > 0).length,
  };
  return res.status(200).json({ users: rows, totals, revenue, series: [...series].map(([d, calls]) => ({ d, calls })), days: days || 'all' });
}
