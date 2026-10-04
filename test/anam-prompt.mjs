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
assert.ok(i(brief) < i('# How to be on this call'), 'representation rules follow the brief');
assert.ok(p.includes(mem));
// no forced script: no mandatory greeting/structure/stock phrases
for (const bad of ['Call structure', 'Open with a casual', 'light pleasantries', 'sign-off']) {
  assert.ok(!p.includes(bad), `prompt must not contain scripted instruction: ${bad}`);
}
// assistant phrases appear only inside the "never say" list, never as an instruction to use them
assert.ok(/Don't say things like "how can I help you"/.test(p));
// representation behaviour
assert.ok(/not an assistant/.test(p) && /private/.test(p) && /never read it out/.test(p));
assert.ok(/never as the first thing you say/.test(p));
assert.ok(/who are you\?/.test(p) && /where is she\?/.test(p) && /without inventing/.test(p));
assert.ok(/on behalf of/.test(p) && /never announce what you are/i.test(p) || /never announce what you are/.test(p));
// identity + situation come from the configured caller and call, not hardcoded
const withId = buildSystemPrompt(brief, '', { callerName: 'Dayo', callContext: { direction: 'outgoing', platform: 'whatsapp', otherName: 'John' } });
assert.ok(withId.includes('You are Dayo') && withId.includes('You called John') && withId.includes('WhatsApp video call'));
const inc = buildSystemPrompt(brief, '', { callContext: { direction: 'incoming', platform: 'whatsapp', otherName: 'Ada' } });
assert.ok(inc.includes('Ada called you and you picked up') && !inc.includes('# Who you are\n'));
assert.ok(!buildSystemPrompt(brief, '', { callerName: '  ' }).includes('# Who you are\n'));
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
assert.ok(api.includes('{ callerName, callContext }'));
assert.ok(!api.includes('BASE_HUMANIZER_PROMPT'));
assert.ok(!api.includes("name: 'Assistant'"));
assert.ok(api.includes('skipGreeting: true'));
assert.equal((api.match(/buildSystemPrompt\(/g) || []).length, 1, 'exactly one prompt build site');
console.log('anam-prompt: all checks passed');

assert.ok(/hmm/.test(p) && /haha/.test(p) && /sigh/.test(p) && /giggle/.test(p) && /Pause the way people do/.test(p) && /Don't write stage directions/.test(p));
console.log('anam-prompt: realism checks passed');

assert.ok(/answer their hello with a hello of your own/.test(p) && /pleasantries before anything from the brief/.test(p) && /never as the first thing you say/.test(p) && /time limit/.test(p));
assert.ok(/Let them speak first/.test(buildSystemPrompt(brief,'',{callContext:{direction:'outgoing',platform:'whatsapp',otherName:'John'}})));
console.log('anam-prompt: opening/pleasantries checks passed');
