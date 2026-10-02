import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSystemPrompt } from '../lib/anamPrompt.js';

const brief = 'You are Dayo, a sarcastic mechanic who is annoyed about a late delivery.';
const mem = 'Likes football. Has a sister called Ada.';
const p = buildSystemPrompt(brief, mem);

// the user's brief reaches the prompt exactly once, verbatim
assert.equal(p.split(brief).length - 1, 1, 'brief must appear exactly once');
// priority order: honesty/safety < brief < memory < defaults
const i = (t) => p.indexOf(t);
assert.ok(i('# Ground rules') < i(brief) && i(brief) < i('# What you know about this person') && i('# What you know about this person') < i('# Defaults for talking on a live call'));
assert.ok(p.includes(mem));
// no forced script: no mandatory greeting/structure/stock phrases
for (const bad of ['Call structure', 'Open with a casual', 'light pleasantries', 'sign-off', 'um,', 'you know,', 'How can I help']) {
  assert.ok(!p.includes(bad), `prompt must not contain scripted instruction: ${bad}`);
}
// honesty rule survives
assert.ok(/sincerely asks/.test(p) && /truthfully/.test(p));
// no brief -> still valid, no "friendly" forced persona, no memory block
const empty = buildSystemPrompt('', '');
assert.ok(empty.includes('No specific brief') && !empty.includes('What you know about this person'));
// whitespace-only brief counts as none
assert.ok(buildSystemPrompt('   ', '').includes('No specific brief'));
// no template placeholders left behind
assert.ok(!/\$\{|undefined|null/.test(p));

// wiring: api/anam.js uses the module, has no leftover second prompt, no generic name
const api = readFileSync(new URL('../api/anam.js', import.meta.url), 'utf8');
assert.ok(api.includes("from '../lib/anamPrompt.js'"));
assert.ok(api.includes('systemPrompt: buildSystemPrompt(systemPrompt, memRow?.facts'));
assert.ok(!api.includes('BASE_HUMANIZER_PROMPT'));
assert.ok(!api.includes("name: 'Assistant'"));
assert.ok(api.includes('skipGreeting: true'));
assert.equal((api.match(/buildSystemPrompt\(/g) || []).length, 1, 'exactly one prompt build site');
console.log('anam-prompt: all checks passed');
