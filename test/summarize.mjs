import assert from 'node:assert/strict';
import { localSummary, summarizeCall, groqText, turnsToText, fmtDuration } from '../lib/summarize.js';

assert.equal(fmtDuration(45), '45s');
assert.equal(fmtDuration(125), '2 min 5s');

// Not answered -> a plain note, no model needed.
assert.match(localSummary({ callee: 'Chris', answered: false, durationSec: 0, turns: [] }), /Chris didn't pick up/);
// Answered, nothing captured.
assert.match(localSummary({ callee: 'Chris', answered: true, durationSec: 30, turns: [] }), /no speech was captured/);
// Answered, with speech: mentions who, how long, what they said.
const turns = [
  { role: 'persona', content: 'Hello Chris' },
  { role: 'user', content: 'Hi, I just got home' },
  { role: 'persona', content: 'Great' },
  { role: 'user', content: 'Talk to you Friday' },
];
const s = localSummary({ callee: 'Chris', answered: true, durationSec: 95, turns });
assert.match(s, /Chris/); assert.match(s, /1 min 35s/); assert.match(s, /just got home/); assert.match(s, /Friday/);

// With no model key at all, a summary is STILL produced (this is the whole point).
const out = await summarizeCall({ apiKey: '', callee: 'Chris', answered: true, durationSec: 95, turns });
assert.ok(out && out.length > 20 && /Chris/.test(out));
assert.equal(await groqText({ apiKey: '', system: 'x', user: 'y' }), null);
assert.match(turnsToText(turns, { calleeName: 'Chris' }), /Chris: Hi, I just got home/);
console.log('summarize: all checks passed');
