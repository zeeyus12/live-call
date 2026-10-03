import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return res.status(500).json({ error: 'Server not configured' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const supabase = createClient('https://ewgtpxomgkpbmfyddypw.supabase.co', serviceKey);
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid session' });

  // Tells the admin's devices that a new account is waiting for approval.
  if (req.body?.action === 'notify-signup') {
    const adminEmail = process.env.ADMIN_EMAIL;
    const vapidPublic = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
    const vapidSubject = process.env.VAPID_SUBJECT;
    if (!adminEmail || !vapidPublic || !vapidPrivate || !vapidSubject) return res.status(500).json({ error: 'Server not configured' });

    const { data: row } = await supabase.from('user_approvals').select('approved, email').eq('user_id', userData.user.id).maybeSingle();
    if (!row || row.approved) return res.status(200).json({ ok: true, skipped: true });

    const { data: adminRow } = await supabase.from('user_approvals').select('user_id').ilike('email', adminEmail.trim()).maybeSingle();
    if (!adminRow) return res.status(200).json({ ok: true, sent: 0 });
    const { data: subs } = await supabase.from('push_subscriptions').select('*').eq('user_id', adminRow.user_id);

    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    const payload = JSON.stringify({ title: 'New signup', body: `${row.email || userData.user.email} is waiting for approval` });
    let sent = 0;
    await Promise.all((subs || []).map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        sent++;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) await supabase.from('push_subscriptions').delete().eq('id', sub.id);
      }
    }));
    return res.status(200).json({ ok: true, sent });
  }

  const { subscription } = req.body || {};
  if (!subscription?.endpoint || !subscription?.keys) return res.status(400).json({ error: 'Invalid subscription' });

  const { error } = await supabase.from('push_subscriptions').upsert({
    user_id: userData.user.id,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
  }, { onConflict: 'endpoint' });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}
