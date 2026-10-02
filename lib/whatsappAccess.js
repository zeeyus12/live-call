// WhatsApp access rules, shared by the Render server (enforcement) and the
// Vercel admin API (display). One pure function so the rule cannot drift:
//
//   admin                      -> always allowed, unlimited
//   Pro (active)               -> allowed, unlimited
//   opened by admin + minutes  -> allowed while minutes remain
//   anything else              -> locked
//
// A user with no row in whatsapp_access is locked: the feature is closed by
// default and the admin opens it per user.

export const PRO_PRICE_NGN = 15000;

export const ACCESS_MESSAGES = {
  locked: `WhatsApp calling is locked for your account. Ask the admin to open it for you, or upgrade to Pro (₦${PRO_PRICE_NGN.toLocaleString('en-NG')}).`,
  no_minutes: `You have used all your WhatsApp minutes. Ask the admin for more, or upgrade to Pro (₦${PRO_PRICE_NGN.toLocaleString('en-NG')}).`,
};

const round2 = (n) => Math.round(n * 100) / 100;

export function evaluateAccess(row, { isAdmin = false, now = Date.now() } = {}) {
  if (isAdmin) {
    return { allowed: true, unlimited: true, plan: 'admin', minutesRemaining: null, reason: null };
  }
  const proActive = row?.plan === 'pro' && (!row.pro_until || new Date(row.pro_until).getTime() > now);
  if (proActive) {
    return { allowed: true, unlimited: true, plan: 'pro', minutesRemaining: null, reason: null };
  }
  const granted = Number(row?.minutes_granted || 0);
  const used = Number(row?.minutes_used || 0);
  const remaining = Math.max(0, round2(granted - used));
  if (!row || !row.unlocked) {
    return { allowed: false, unlimited: false, plan: 'free', minutesRemaining: 0, reason: 'locked' };
  }
  if (remaining <= 0) {
    return { allowed: false, unlimited: false, plan: 'free', minutesRemaining: 0, reason: 'no_minutes' };
  }
  return { allowed: true, unlimited: false, plan: 'free', minutesRemaining: remaining, reason: null };
}
