// Call summaries that always get written and sent.
//
// Two things used to make summaries fail quietly:
//  1. one hard-coded Groq model name - when Groq retires a model every summary
//     became "no summary could be generated";
//  2. nothing at all to fall back on when the model call failed.
// So: ask Groq which chat models exist right now and try them in order, and if none
// answers, write the summary locally from the transcript. A summary is always produced.

const NOT_CHAT = /whisper|guard|tts|orpheus|playai|embed|safeguard|transcri|vision-preview/i;

export async function groqText({ apiKey, system, user, temperature = 0.5, maxTokens = 350, timeoutMs = 12000 }) {
  if (!apiKey) return null;
  let live = [];
  try {
    const lr = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000) });
    const ld = await lr.json().catch(() => ({}));
    live = (ld.data || []).map((m) => m.id).filter((id) => id && !NOT_CHAT.test(id));
  } catch (e) { /* use the static list */ }
  const preferred = [process.env.GROQ_TEXT_MODEL, 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'];
  const models = [...new Set([...preferred.filter(Boolean), ...live])].slice(0, 6);
  for (const model of models) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature, max_completion_tokens: maxTokens }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await r.json().catch(() => ({}));
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (r.ok && text) return text;
      if (r.status === 401) return null; // bad key - other models will not help
    } catch (e) { /* try the next model */ }
  }
  return null;
}

// Turns -> "Caller: ...\nPersona: ..." ; accepts {role,content|text}
export function turnsToText(turns, { calleeName = 'The other person' } = {}) {
  return (turns || [])
    .filter((t) => (t?.content || t?.text))
    .map((t) => `${/^(user|caller|callee|human)$/i.test(t.role || '') ? calleeName : 'Avatar'}: ${String(t.content || t.text).replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60}s` : `${s}s`;
}

// No-model fallback: facts only, but always something useful to read.
export function localSummary({ callee, answered, durationSec, turns }) {
  const who = callee || 'the number you called';
  if (!answered) return `${who} didn't pick up your WhatsApp call.`;
  const spoken = (turns || []).filter((t) => (t?.content || t?.text));
  const theirs = spoken.filter((t) => /^(user|caller|callee|human)$/i.test(t.role || ''));
  if (!spoken.length) return `Your WhatsApp call with ${who} lasted ${fmtDuration(durationSec)}, but no speech was captured.`;
  const firstTheirs = theirs[0] && String(theirs[0].content || theirs[0].text).trim();
  const lastTheirs = theirs.length > 1 && String(theirs[theirs.length - 1].content || theirs[theirs.length - 1].text).trim();
  let s = `Your WhatsApp call with ${who} lasted ${fmtDuration(durationSec)} (${spoken.length} messages).`;
  if (firstTheirs) s += ` They started with: "${firstTheirs.slice(0, 140)}".`;
  if (lastTheirs && lastTheirs !== firstTheirs) s += ` Their last words were: "${lastTheirs.slice(0, 140)}".`;
  return s;
}

export async function summarizeCall({ apiKey, callee, answered, durationSec, turns, platform = 'whatsapp' }) {
  if (!answered) return localSummary({ callee, answered, durationSec, turns });
  const system = `You just finished a live ${platform === 'whatsapp' ? 'WhatsApp ' : ''}call as an AI persona. Write a short natural summary of
the call for the person who set up the call to read afterward - warm, plain language, first-person
("I called X, we talked about..."). Cover: who was called (if named), what was discussed, anything the other
person shared that's worth remembering (mood, news, requests), and how the call ended. 2-4 sentences.
No headers, no bullet points, just a short natural paragraph.`;
  const text = turnsToText(turns, { calleeName: callee || 'Them' });
  const user = `Called: ${callee || 'unknown'}\nDuration: ${fmtDuration(durationSec)}\n\n${text || '(No speech was captured on this call.)'}`;
  const out = await groqText({ apiKey, system, user, temperature: 0.6, maxTokens: 300 });
  return out || localSummary({ callee, answered, durationSec, turns });
}
