/**
 * Memory Engine — Test Suite
 * Covers: store, flags, retrieval, reflect, profile, index API, Piggy adapter.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const path = require('path');
const fs = require('fs');
const memory = require('./index');
const store = require('./store');
const flags = require('./flags');
const piggyAdapter = require('./adapters/piggy');

const TEST_DB = path.join(__dirname, 'test-memory.db');

let passed = 0;
let failed = 0;
let currentSection = '';

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${msg}`);
  } else {
    failed++;
    console.log(`  \u2717 ${msg}`);
  }
}

function section(name) {
  currentSection = name;
  console.log(`\n\u2550\u2550 ${name} \u2550\u2550`);
}

function cleanup() {
  try { memory.close(); } catch (_) {}
  try { fs.unlinkSync(TEST_DB); } catch (_) {}
  try { fs.unlinkSync(TEST_DB + '-wal'); } catch (_) {}
  try { fs.unlinkSync(TEST_DB + '-shm'); } catch (_) {}
}

// ══════════════════════════════════════════════════════════
// TOKENIZER
// ══════════════════════════════════════════════════════════

function testTokenizer() {
  section('Tokenizer');

  assert(store.tokenize('Hello World!') === 'hello world', 'basic tokenization');
  assert(store.tokenize('Click at (400, 200)') === 'click at 400 200', 'strips parens/commas');
  assert(store.tokenize('the the the') === 'the', 'deduplicates');
  assert(store.tokenize('a') === '', 'filters single-char');
  assert(store.tokenize('') === '', 'empty string');
  assert(store.tokenize(null) === '', 'null');
  assert(store.tokenize('   ') === '', 'whitespace-only');
  assert(store.tokenize('!@#$%') === '', 'punctuation-only');

  const arr = store.tokenizeToArray('Hello World!');
  assert(Array.isArray(arr) && arr.length === 2, 'tokenizeToArray works');
  assert(store.tokenizeToArray('').length === 0, 'tokenizeToArray empty');
  assert(store.tokenizeToArray(null).length === 0, 'tokenizeToArray null');
}

// ══════════════════════════════════════════════════════════
// GUARD CLAUSES
// ══════════════════════════════════════════════════════════

function testGuards() {
  section('Guard clauses');

  const fns = ['startSession', 'stats', 'checkFlags', 'getProfile', 'getSkills'];
  for (const fn of fns) {
    let threw = false;
    try { memory[fn]('test'); } catch (e) { threw = e.message.includes('not initialized'); }
    assert(threw, `${fn} throws when not initialized`);
  }
}

// ══════════════════════════════════════════════════════════
// STORE — Sessions & Memories
// ══════════════════════════════════════════════════════════

function testStore() {
  section('Store — Sessions');

  memory.init(TEST_DB);

  const sid = memory.startSession('Open Brave and search', { app: 'Brave' });
  assert(typeof sid === 'number' || typeof sid === 'bigint', 'createSession returns ID');

  const session = store.getSession(sid);
  assert(session && session.metadata && session.metadata.app === 'Brave', 'metadata stored');

  memory.endSession(sid, 'success', 5);
  const sessions = memory.getRecentSessions(10);
  assert(sessions[0].outcome === 'success', 'outcome saved');
  assert(sessions[0].step_count === 5, 'step_count saved');

  let threw = false;
  try { memory.endSession(sid, 'bad_outcome', 1); } catch (_) { threw = true; }
  assert(threw, 'rejects invalid outcome');

  section('Store — Memories');

  const m1 = memory.storeMemory(sid, 'action', 'Click at (400, 200)', 1);
  const m2 = memory.storeObservation(sid, 'Search bar focused', 1);
  const m3 = memory.storeError(sid, 'Element not found', 2);
  assert(m1 && m2 && m3, 'storeMemory/Observation/Error return IDs');

  const mems = memory.getSessionMemories(sid);
  assert(mems.length === 3, `3 memories stored (got ${mems.length})`);
  assert(mems[0].type === 'action', 'correct type: action');
  assert(mems[1].type === 'observation', 'correct type: observation');
  assert(mems[2].type === 'error', 'correct type: error');

  threw = false;
  try { memory.storeMemory(sid, 'invalid', 'test', 1); } catch (_) { threw = true; }
  assert(threw, 'rejects invalid type');

  section('Store — Search edge cases');

  assert(store.searchMemories('').length === 0, 'empty query = no results');
  assert(store.searchMemories(null).length === 0, 'null query = no results');
  assert(store.searchMemories('!!!').length === 0, 'punctuation query = no results');

  section('Store — Re-init');
  memory.close();
  memory.init(TEST_DB);
  assert(memory.stats().sessions >= 1, 're-init preserves data');
  memory.close();
}

// ══════════════════════════════════════════════════════════
// STORE — Skills
// ══════════════════════════════════════════════════════════

function testSkills() {
  section('Store — Skills');

  memory.init(TEST_DB);

  const sid = memory.startSession('skill test');

  const skillId = store.addSkill({
    name: 'Navigate to URL via Brave Reflection',
    description: 'Open a URL in Brave Browser',
    steps: ['Focus Brave Browser', 'Press Cmd+L to focus address bar', 'Type the URL', 'Press Enter'],
    preconditions: 'Brave Browser must be installed',
    app_context: 'Brave Browser',
    confidence: 0.3,
    source_session_id: sid
  });
  assert(skillId, 'addSkill returns ID');

  const skill = store.getSkill(skillId);
  assert(skill.name === 'Navigate to URL via Brave Reflection', 'skill name stored');
  assert(Array.isArray(skill.steps), 'steps parsed as array');
  assert(skill.steps.length === 4, '4 steps stored');
  assert(skill.confidence === 0.3, 'initial confidence 0.3');
  assert(skill.app_context === 'Brave Browser', 'app_context stored');
  assert(skill.preconditions === 'Brave Browser must be installed', 'preconditions stored');

  // Reinforce
  store.reinforceSkill(skillId);
  const after = store.getSkill(skillId);
  assert(after.confidence === 0.4, 'reinforce increases confidence by 0.1');

  // Weaken
  store.weakenSkill(skillId);
  const weakened = store.getSkill(skillId);
  assert(weakened.confidence === 0.25, 'weaken decreases confidence by 0.15');

  // Confidence ceiling: reinforce past 1.0
  const ceilSid = memory.startSession('ceil test');
  const ceilId = store.addSkill({
    name: 'Ceil Test Skill',
    description: 'test',
    steps: ['step'],
    confidence: 0.95,
    source_session_id: ceilSid
  });
  store.reinforceSkill(ceilId);
  assert(store.getSkill(ceilId).confidence === 1.0, 'confidence capped at 1.0');
  store.reinforceSkill(ceilId);
  assert(store.getSkill(ceilId).confidence === 1.0, 'stays at 1.0 after double reinforce');

  // Confidence floor: weaken past 0.0
  const floorSid = memory.startSession('floor test');
  const floorId = store.addSkill({
    name: 'Floor Test Skill',
    description: 'test',
    steps: ['step'],
    confidence: 0.1,
    source_session_id: floorSid
  });
  store.weakenSkill(floorId);
  assert(store.getSkill(floorId).confidence === 0.0, 'confidence floors at 0.0');
  store.weakenSkill(floorId);
  assert(store.getSkill(floorId).confidence === 0.0, 'stays at 0.0 after double weaken');

  // UNIQUE constraint: duplicate name should throw
  let dupeThrew = false;
  try {
    store.addSkill({ name: 'Navigate to URL via Brave Reflection', description: 'dupe', steps: ['x'] });
  } catch (_) { dupeThrew = true; }
  assert(dupeThrew, 'UNIQUE constraint prevents duplicate skill names');

  // Search
  const found = store.searchSkills('navigate URL Brave');
  assert(found.length > 0, 'searchSkills finds by keywords');
  assert(found[0].name === 'Navigate to URL via Brave Reflection', 'correct skill found');

  const empty = store.searchSkills('');
  assert(empty.length === 0, 'empty search = no results');

  // By app
  const byApp = store.getSkillsByApp('Brave Browser');
  assert(byApp.length > 0, 'getSkillsByApp works');

  // Find by name
  const byName = store.findSkillByName('Navigate to URL via Brave Reflection');
  assert(byName && byName.name === 'Navigate to URL via Brave Reflection', 'findSkillByName works');

  const noName = store.findSkillByName('nonexistent');
  assert(noName === null, 'findSkillByName returns null for missing');

  // Top skills
  store.reinforceSkill(skillId); // bring confidence back up
  store.reinforceSkill(skillId);
  const top = store.getTopSkills(5);
  assert(top.length > 0, 'getTopSkills returns skills');

  memory.close();
}

// ══════════════════════════════════════════════════════════
// STORE — Reflections
// ══════════════════════════════════════════════════════════

function testReflections() {
  section('Store — Reflections');

  memory.init(TEST_DB);

  const sid = memory.startSession('reflection test');
  memory.endSession(sid, 'success', 3);

  const refId = store.addReflection({
    session_id: sid,
    outcome: 'success',
    what_happened: 'Opened Brave and navigated to google.com',
    what_worked: 'Using Cmd+L to focus address bar was faster than clicking',
    what_failed: null,
    strategy: 'Focus app, Cmd+L, type URL, Enter',
    anti_pattern: null,
    confidence: 0.3
  });
  assert(refId, 'addReflection returns ID');

  const ref = store.getReflection(refId);
  assert(ref.what_happened.includes('Brave'), 'what_happened stored');
  assert(ref.what_worked.includes('Cmd+L'), 'what_worked stored');
  assert(ref.confidence === 0.3, 'initial confidence 0.3');
  assert(ref.confirmed === 0, 'not confirmed initially');

  // Confirm
  store.confirmReflection(refId);
  const confirmed = store.getReflection(refId);
  assert(confirmed.confirmed === 1, 'confirmed after confirmReflection');
  assert(confirmed.confidence === 0.5, 'confidence increased on confirm');

  // Session reflection
  const sessionRef = store.getSessionReflection(sid);
  assert(sessionRef && Number(sessionRef.id) === Number(refId), 'getSessionReflection works');

  // Add failure reflection with anti-pattern
  const sid2 = memory.startSession('failed task');
  memory.endSession(sid2, 'failure', 2);
  store.addReflection({
    session_id: sid2,
    outcome: 'failure',
    what_happened: 'Tried to open Terminal but window was not detected',
    what_worked: null,
    what_failed: 'Terminal window was behind other apps',
    strategy: null,
    anti_pattern: 'Terminal window may be hidden — use Spotlight (Cmd+Space) instead of looking for the window',
    confidence: 0.3
  });

  // Search
  const found = store.searchReflections('Terminal window');
  assert(found.length > 0, 'searchReflections finds by keywords');

  const antiPatterns = store.getAntiPatterns(5);
  assert(antiPatterns.length > 0, 'getAntiPatterns returns results');
  assert(antiPatterns[0].anti_pattern.includes('Terminal'), 'anti-pattern content correct');

  memory.close();
}

// ══════════════════════════════════════════════════════════
// CLASSIFY & STORE
// ══════════════════════════════════════════════════════════

function testClassify() {
  section('Classify & Store');

  memory.init(TEST_DB);
  const sid = memory.startSession('classify test');

  // All Piggy action types
  memory.classifyAndStore(sid, { action: 'click', x: 500, y: 300 }, 1);
  memory.classifyAndStore(sid, { action: 'right_click', x: 100, y: 200 }, 2);
  memory.classifyAndStore(sid, { action: 'type', text: 'hello' }, 3);
  memory.classifyAndStore(sid, { action: 'key', key: 'enter' }, 4);
  memory.classifyAndStore(sid, { action: 'shortcut', key: 't', modifiers: ['command'] }, 5);
  memory.classifyAndStore(sid, { action: 'focus', app: 'Brave' }, 6);
  memory.classifyAndStore(sid, { action: 'find', name: 'Search' }, 7);
  memory.classifyAndStore(sid, { action: 'skill', skill: 'clipboard', method: 'read' }, 8);
  memory.classifyAndStore(sid, { action: 'recall', query: 'how to open Brave' }, 9);
  memory.classifyAndStore(sid, { action: 'done', reason: 'completed' }, 10);
  memory.classifyAndStore(sid, { action: 'fail', reason: 'not found' }, 11);
  memory.classifyAndStore(sid, null, 12);

  const mems = memory.getSessionMemories(sid);
  assert(mems.length === 12, `12 entries created (got ${mems.length})`);

  const types = mems.map(m => m.type);
  assert(types[9] === 'result', 'done → result');
  assert(types[10] === 'error', 'fail → error');
  assert(types[11] === 'error', 'null → error');
  assert(types.filter(t => t === 'action').length === 9, '9 actions');

  assert(mems[7].content.includes('clipboard'), 'skill described');
  assert(mems[8].content.includes('how to open Brave'), 'recall described');

  memory.close();
}

// ══════════════════════════════════════════════════════════
// FLAGS
// ══════════════════════════════════════════════════════════

function testFlags() {
  section('Flags — Repetition');

  const rep3 = [
    { type: 'action', content: 'Click at (400, 200)' },
    { type: 'action', content: 'Click at (400, 200)' },
    { type: 'action', content: 'Click at (400, 200)' }
  ];
  assert(flags.checkAll(rep3).some(f => f.type === 'repetition'), '3x repetition detected');

  const rep2 = [
    { type: 'action', content: 'Click at (400, 200)' },
    { type: 'action', content: 'Click at (400, 200)' }
  ];
  assert(flags.checkAll(rep2, { repetitionThreshold: 2 }).some(f => f.type === 'repetition'), '2x with threshold=2');

  const varied = [
    { type: 'action', content: 'Click' },
    { type: 'action', content: 'Type' },
    { type: 'action', content: 'Enter' }
  ];
  assert(!flags.checkAll(varied).some(f => f.type === 'repetition'), 'no false positive on varied');

  assert(flags.checkAll([]).length === 0, 'empty = no flags');
  assert(flags.checkAll(null).length === 0, 'null = no flags');

  section('Flags — Contradiction');

  const contra = [
    { type: 'action', content: 'Click button' },
    { type: 'result', content: 'Task completed successfully' },
    { type: 'action', content: 'Click another' },
    { type: 'action', content: 'Type something' }
  ];
  assert(flags.checkAll(contra).some(f => f.type === 'contradiction'), 'done-then-continue');

  section('Flags — Loop');

  const abab = [
    { type: 'action', content: 'Click A' },
    { type: 'action', content: 'Click B' },
    { type: 'action', content: 'Click A' },
    { type: 'action', content: 'Click B' }
  ];
  assert(flags.checkAll(abab).some(f => f.type === 'loop'), 'A-B-A-B loop detected');

  section('Flags — Redundancy');

  const redundant = [
    { type: 'action', content: 'Click search bar' },
    { type: 'observation', content: 'Search bar clicked and focused' },
    { type: 'action', content: 'Type hello' },
    { type: 'action', content: 'Click search bar' }
  ];
  assert(flags.checkAll(redundant).some(f => f.type === 'redundancy'), 'redundant action detected');

  section('Flags — isSuccessObservation');

  assert(!flags.isSuccessObservation('not loaded'), 'negation: "not loaded"');
  assert(!flags.isSuccessObservation('failed to click'), 'negation: "failed to click"');
  assert(!flags.isSuccessObservation("couldn't find"), 'negation: "couldn\'t find"');
  assert(flags.isSuccessObservation('Page loaded successfully'), 'positive: "loaded"');
  assert(flags.isSuccessObservation('Button clicked'), 'positive: "clicked"');
  assert(!flags.isSuccessObservation(''), 'empty = not success');
  assert(!flags.isSuccessObservation(null), 'null = not success');
}

// ══════════════════════════════════════════════════════════
// REFLECTION
// ══════════════════════════════════════════════════════════

function testReflection() {
  section('Reflection — Prompt Building');

  memory.init(TEST_DB);

  const sid = memory.startSession('Open Brave and go to google.com');
  memory.storeMemory(sid, 'task', 'Open Brave and go to google.com', 0);
  memory.classifyAndStore(sid, { action: 'focus', app: 'Brave' }, 1);
  memory.storeObservation(sid, 'Brave is in focus', 1);
  memory.classifyAndStore(sid, { action: 'click', x: 400, y: 50 }, 2);
  memory.storeObservation(sid, 'Address bar focused', 2);
  memory.classifyAndStore(sid, { action: 'type', text: 'google.com' }, 3);
  memory.classifyAndStore(sid, { action: 'key', key: 'enter' }, 4);
  memory.storeObservation(sid, 'Google homepage loaded', 4);
  memory.classifyAndStore(sid, { action: 'done', reason: 'Google loaded' }, 5);
  memory.endSession(sid, 'success', 5);

  const promptData = memory.getReflectionPrompt(sid);
  assert(promptData !== null, 'getReflectionPrompt returns data');
  assert(promptData.prompt.includes('TASK:'), 'prompt has TASK');
  assert(promptData.prompt.includes('TIMELINE'), 'prompt has TIMELINE');
  assert(promptData.prompt.includes('OUTCOME: success'), 'prompt has outcome');
  assert(promptData.prompt.includes('semantic descriptions'), 'prompt warns about coordinates');
  assert(promptData.prompt.includes('RULES'), 'prompt has constraints');

  section('Reflection — Processing');

  // Simulate model response
  const modelResponse = JSON.stringify({
    what_happened: 'Opened Brave, focused address bar, typed URL, pressed Enter. Google loaded.',
    what_worked: 'Clicking the address bar area directly worked to focus it.',
    what_failed: null,
    strategy: 'Focus Brave, click or use Cmd+L for address bar, type URL, press Enter, wait for load.',
    strategy_name: 'Go to google.com in Brave',
    strategy_steps: [
      'Focus Brave Browser',
      'Focus the address bar (Cmd+L or click the address bar area)',
      'Type the full URL',
      'Press Enter',
      'Wait for page to load before declaring done'
    ],
    app_context: 'Brave Browser',
    anti_pattern: null,
    preconditions: 'Brave Browser must be running'
  });

  const result = memory.processReflection(sid, modelResponse);
  assert(result !== null, 'processReflection returns result');
  assert(result.reflection !== null, 'reflection stored');
  assert(result.reflection.what_happened.includes('Brave'), 'reflection content correct');
  assert(result.reflection.confidence > 0, 'reflection has confidence');

  assert(result.skill !== null, 'skill created from successful reflection');
  assert(result.skill.name === 'Go to google.com in Brave', 'skill name correct');
  assert(Array.isArray(result.skill.steps), 'skill steps is array');
  assert(result.skill.app_context === 'Brave Browser', 'skill app_context correct');

  // Check fresh skill from DB
  const freshSkill = store.getSkill(result.skill.id);
  assert(freshSkill.confidence === 0.4, 'skill inherits reflection confidence (0.4 for success)');
  assert(freshSkill.steps.length === 5, 'skill has 5 steps');

  // Process again — should reinforce existing skill
  const result2 = memory.processReflection(sid, modelResponse);
  assert(result2 !== null, 'second processReflection works');
  assert(result2.skill !== null, 'skill returned on second process');
  const reinforced = store.getSkill(result2.skill.id);
  assert(reinforced.confidence > freshSkill.confidence, 'skill reinforced on duplicate (confidence increased)');

  section('Reflection — Bad input');

  assert(memory.processReflection(sid, '') === null, 'empty response = null');
  assert(memory.processReflection(sid, 'not json') === null, 'invalid JSON = null');
  assert(memory.processReflection(sid, '{"foo":"bar"}') === null, 'missing what_happened = null');
  assert(memory.processReflection(999999, modelResponse) === null, 'bad session ID = null');

  section('Reflection — Failure produces anti-pattern');

  const sid2 = memory.startSession('Open Terminal and run ls');
  memory.storeMemory(sid2, 'task', 'Open Terminal and run ls', 0);
  memory.classifyAndStore(sid2, { action: 'focus', app: 'Terminal' }, 1);
  memory.storeError(sid2, 'Terminal window not found', 1);
  memory.endSession(sid2, 'failure', 1);

  const failResponse = JSON.stringify({
    what_happened: 'Tried to focus Terminal but it was not detected.',
    what_worked: null,
    what_failed: 'Terminal window was not found by the executor.',
    strategy: null,
    strategy_name: null,
    strategy_steps: null,
    app_context: 'Terminal',
    anti_pattern: 'Terminal window may be hidden. Try using Spotlight (Cmd+Space) to launch it instead.',
    preconditions: null
  });

  const failResult = memory.processReflection(sid2, failResponse);
  assert(failResult !== null, 'failure reflection processed');
  assert(failResult.reflection.anti_pattern.includes('Spotlight'), 'anti-pattern stored');
  assert(failResult.skill === null, 'no skill from failed task');
  assert(failResult.reflection.confidence === 0.25, 'failure reflection lower confidence');

  memory.close();
}

// ══════════════════════════════════════════════════════════
// PROFILE
// ══════════════════════════════════════════════════════════

function testProfile() {
  section('Profile');

  memory.init(TEST_DB);

  // Seed: session + skill + anti-pattern
  const sid = memory.startSession('profile test');
  memory.endSession(sid, 'success', 3);

  store.addSkill({
    name: 'Open URL in Brave',
    description: 'Navigate to a URL',
    steps: ['Focus Brave', 'Cmd+L', 'Type URL', 'Enter'],
    app_context: 'Brave Browser',
    confidence: 0.7,
    source_session_id: sid
  });

  store.addReflection({
    session_id: sid,
    outcome: 'failure',
    what_happened: 'Terminal failed',
    what_failed: 'Window hidden',
    anti_pattern: 'Terminal may be hidden behind other windows',
    confidence: 0.4
  });

  const prof = memory.getProfile({ agentName: 'TestAgent' });
  assert(prof.includes('TestAgent'), 'profile has agent name');
  assert(prof.includes('Open URL in Brave'), 'profile includes skill');
  assert(prof.includes('Brave Browser'), 'profile includes app');
  assert(prof.includes('Terminal'), 'profile includes anti-pattern');
  assert(prof.includes('recall'), 'profile mentions recall action');
  assert(prof.includes('find'), 'profile mentions find action');

  const taskCtx = memory.getTaskContext('open Brave and go to youtube');
  assert(taskCtx.includes('Open URL in Brave') || taskCtx.includes('Brave'), 'taskContext has relevant skill');

  // Empty profile
  memory.close();
  cleanup();
  memory.init(TEST_DB);
  const emptyProf = memory.getProfile();
  assert(emptyProf === '', 'empty profile when no data');

  memory.close();
}

// ══════════════════════════════════════════════════════════
// RETRIEVAL — Recall
// ══════════════════════════════════════════════════════════

function testRetrieval() {
  section('Retrieval — Recall');

  memory.init(TEST_DB);

  const sid = memory.startSession('retrieval test');
  memory.endSession(sid, 'success', 3);

  store.addSkill({
    name: 'Search in Brave',
    description: 'Search for something using Brave',
    steps: ['Focus Brave', 'Click search bar', 'Type query', 'Press Enter'],
    app_context: 'Brave Browser',
    confidence: 0.6,
    source_session_id: sid
  });

  store.addReflection({
    session_id: sid,
    outcome: 'failure',
    what_happened: 'Finder crashed',
    anti_pattern: 'Finder sometimes crashes when too many windows open',
    confidence: 0.3
  });

  memory.storeMemory(sid, 'action', 'Focus app Brave Browser', 1);
  memory.storeMemory(sid, 'observation', 'Brave is focused', 1);

  // Recall finds skills first
  const results = memory.recall('search in Brave');
  assert(results.length > 0, 'recall returns results');
  assert(results[0].source === 'skill', 'skills prioritized');
  assert(results[0].content.includes('Search in Brave'), 'correct skill found');

  // Formatted recall
  const formatted = memory.recallFormatted('search in Brave');
  assert(formatted.includes('Memory recall'), 'formatted has header');
  assert(formatted.includes('Search in Brave'), 'formatted has skill');

  // Empty recall
  const empty = memory.recall('xyzzy nonexistent garbage');
  // Should fall through to raw memories if nothing else matches
  assert(Array.isArray(empty), 'empty recall returns array');

  // Recall with no data
  const noData = memory.recallFormatted('completely unrelated query zzzz');
  assert(noData.includes('No relevant memories') || noData.includes('recall'), 'no data handled');

  memory.close();
}

// ══════════════════════════════════════════════════════════
// PIGGY ADAPTER
// ══════════════════════════════════════════════════════════

function testPiggyAdapter() {
  section('Piggy Adapter — beforeTask');

  piggyAdapter.init(TEST_DB);

  // Seed a skill so beforeTask has something to find
  const seedSid = memory.startSession('seed');
  memory.endSession(seedSid, 'success', 1);
  store.addSkill({
    name: 'Navigate URL',
    description: 'Open a website',
    steps: ['Focus browser', 'Cmd+L', 'Type URL', 'Enter'],
    app_context: 'Brave Browser',
    confidence: 0.7,
    source_session_id: seedSid
  });

  const ctx = piggyAdapter.beforeTask('Open Brave and go to google.com', { app: 'Brave Browser' });
  assert(typeof ctx.sessionId === 'number' || typeof ctx.sessionId === 'bigint', 'returns sessionId');
  assert(typeof ctx.profile === 'string', 'returns profile');
  assert(typeof ctx.taskContext === 'string', 'returns taskContext');
  assert(Array.isArray(ctx.activeSkillIds), 'returns activeSkillIds');

  section('Piggy Adapter — afterStep');

  const step1 = piggyAdapter.afterStep(ctx.sessionId, { action: 'focus', app: 'Brave' }, 1);
  assert(Array.isArray(step1.flags), 'returns flags');
  assert(step1.isRecall === false, 'not a recall');

  // Batch
  const step2 = piggyAdapter.afterStep(ctx.sessionId, [
    { action: 'click', x: 400, y: 50 },
    { action: 'type', text: 'google.com' }
  ], 2);
  assert(step2.flags.length === 0, 'no flags on normal batch');

  section('Piggy Adapter — Recall action');

  const recallStep = piggyAdapter.afterStep(ctx.sessionId, { action: 'recall', query: 'how to navigate in Brave' }, 3);
  assert(recallStep.isRecall === true, 'recall detected');
  assert(typeof recallStep.recallResult === 'string', 'recall result is string');
  assert(recallStep.recallResult.length > 0, 'recall result has content');

  section('Piggy Adapter — onStepResult');

  piggyAdapter.onStepResult(ctx.sessionId, { action: 'click' }, true, 'Button clicked', 2);
  const afterObs = memory.getSessionMemories(ctx.sessionId);
  assert(afterObs.some(m => m.type === 'observation' && m.content.includes('Button clicked')), 'success → observation');

  piggyAdapter.onStepResult(ctx.sessionId, { action: 'find' }, false, 'Element not found', 3);
  const afterErr = memory.getSessionMemories(ctx.sessionId);
  assert(afterErr.some(m => m.type === 'error' && m.content.includes('Element not found')), 'failure → error');

  piggyAdapter.onStepResult(ctx.sessionId, { action: 'click' }, false, null, 4);
  const afterNull = memory.getSessionMemories(ctx.sessionId);
  assert(afterNull.some(m => m.type === 'error' && m.content.includes('Action failed')), 'null detail handled');

  section('Piggy Adapter — afterTask');

  const taskResult = piggyAdapter.afterTask(ctx.sessionId, 'success', 5, ctx.activeSkillIds);
  assert(typeof taskResult.reflectionPrompt === 'string', 'returns reflection prompt');
  assert(taskResult.reflectionPrompt.includes('TASK'), 'prompt has task');

  // Skills should be reinforced
  if (ctx.activeSkillIds.length > 0) {
    const reinforced = store.getSkill(ctx.activeSkillIds[0]);
    assert(reinforced.confidence > 0.7, 'active skill reinforced on success (confidence increased)');
  }

  section('Piggy Adapter — onReflection');

  const reflResponse = JSON.stringify({
    what_happened: 'Opened Brave and loaded Google.',
    what_worked: 'Cmd+L for address bar.',
    what_failed: null,
    strategy: 'Focus Brave, Cmd+L, type URL, Enter.',
    strategy_name: 'Open URL in Brave',
    strategy_steps: ['Focus Brave', 'Press Cmd+L', 'Type URL', 'Press Enter'],
    app_context: 'Brave Browser',
    anti_pattern: null,
    preconditions: null
  });

  const reflResult = piggyAdapter.onReflection(ctx.sessionId, reflResponse);
  assert(reflResult !== null, 'onReflection returns result');
  assert(reflResult.reflection !== null, 'reflection stored');
  assert(reflResult.skill !== null, 'skill created');

  section('Piggy Adapter — Flag trigger');

  const flagSid = memory.startSession('flag test');
  memory.storeMemory(flagSid, 'task', 'flag test', 0);
  piggyAdapter.afterStep(flagSid, { action: 'click', x: 100, y: 100 }, 1);
  piggyAdapter.afterStep(flagSid, { action: 'click', x: 100, y: 100 }, 2);
  const flagStep = piggyAdapter.afterStep(flagSid, { action: 'click', x: 100, y: 100 }, 3);
  assert(flagStep.flags.length > 0, 'flags fire on repetition');
  assert(flagStep.contextBoost.includes('WARNING'), 'contextBoost has WARNING');

  section('Piggy Adapter — Utilities');

  assert(piggyAdapter.getStats() !== null, 'getStats works');
  assert(Array.isArray(piggyAdapter.getHistory(5)), 'getHistory works');
  assert(Array.isArray(piggyAdapter.getSkills(5)), 'getSkills works');

  piggyAdapter.close();
}

// ══════════════════════════════════════════════════════════
// STATS
// ══════════════════════════════════════════════════════════

function testStats() {
  section('Stats');

  memory.init(TEST_DB);

  const s = memory.stats();
  assert(typeof s.sessions === 'number', 'stats.sessions is number');
  assert(typeof s.memories === 'number', 'stats.memories is number');
  assert(typeof s.skills === 'number', 'stats.skills is number');
  assert(typeof s.reflections === 'number', 'stats.reflections is number');
  assert(typeof s.confirmedReflections === 'number', 'stats.confirmedReflections is number');
  assert(typeof s.avgConfidence === 'number', 'stats.avgConfidence is number');
  assert(Array.isArray(s.topApps), 'stats.topApps is array');

  memory.close();
}

// ══════════════════════════════════════════════════════════
// EDGE CASES — decaySkills, 3-step loop, JSON parsing, empty timeline
// ══════════════════════════════════════════════════════════

function testEdgeCases() {
  section('Edge — decaySkills');

  memory.init(TEST_DB);

  // New skill (last_used_at = NULL) should NOT be decayed
  const sid = memory.startSession('decay test');
  const newSkillId = store.addSkill({
    name: 'Brand New Skill',
    description: 'just created',
    steps: ['step1'],
    confidence: 0.3,
    source_session_id: sid
  });
  store.decaySkills(0); // decay everything older than 0 hours
  const afterDecay = store.getSkill(newSkillId);
  assert(afterDecay.confidence === 0.3, 'new skill (null last_used_at) NOT decayed');

  // Used skill that is stale SHOULD be decayed
  store.reinforceSkill(newSkillId); // sets last_used_at
  // Manually backdate last_used_at to 2 weeks ago
  store.getDb().prepare(
    `UPDATE skills SET last_used_at = datetime('now', 'utc', '-336 hours') WHERE id = ?`
  ).run(newSkillId);
  store.decaySkills(168); // decay skills not used in 1 week
  const afterStaleDecay = store.getSkill(newSkillId);
  assert(afterStaleDecay.confidence < 0.4, 'stale skill decayed');
  assert(afterStaleDecay.confidence >= 0.05, 'decay respects floor of 0.05');

  section('Edge — 3-step loop detection');

  const abcabc = [
    { type: 'action', content: 'Click A' },
    { type: 'action', content: 'Click B' },
    { type: 'action', content: 'Click C' },
    { type: 'action', content: 'Click A' },
    { type: 'action', content: 'Click B' },
    { type: 'action', content: 'Click C' }
  ];
  assert(flags.checkAll(abcabc).some(f => f.type === 'loop'), 'A-B-C-A-B-C 3-step loop detected');

  section('Edge — reflection with non-string input');

  const nonString = memory.processReflection(sid, 12345);
  assert(nonString === null, 'processReflection rejects non-string input');

  const objInput = memory.processReflection(sid, { foo: 'bar' });
  assert(objInput === null, 'processReflection rejects object input');

  section('Edge — reflection JSON with commentary');

  // Model adds text before/after JSON
  const withCommentary = 'Here is my reflection:\n' + JSON.stringify({
    what_happened: 'Task completed successfully.',
    what_worked: 'Everything',
    what_failed: null,
    strategy: null,
    strategy_name: null,
    strategy_steps: null,
    app_context: null,
    anti_pattern: null,
    preconditions: null
  }) + '\nEnd of reflection.';

  const commentResult = memory.processReflection(sid, withCommentary);
  assert(commentResult !== null, 'processReflection handles JSON with surrounding text');
  assert(commentResult.reflection.what_happened.includes('successfully'), 'extracts correct JSON from commentary');

  section('Edge — empty timeline returns null prompt');

  const emptySid = memory.startSession('empty session');
  memory.endSession(emptySid, 'failure', 0);
  const emptyPrompt = memory.getReflectionPrompt(emptySid);
  assert(emptyPrompt === null, 'empty session returns null reflection prompt');

  // Session with only a task memory (no actions/observations)
  const taskOnlySid = memory.startSession('task only');
  memory.storeMemory(taskOnlySid, 'task', 'do something', 0);
  memory.endSession(taskOnlySid, 'failure', 0);
  const taskOnlyPrompt = memory.getReflectionPrompt(taskOnlySid);
  assert(taskOnlyPrompt === null, 'task-only session returns null (no executor data)');

  section('Edge — searchReflections has relevance');

  const refSid = memory.startSession('relevance test');
  memory.endSession(refSid, 'failure', 1);
  store.addReflection({
    session_id: refSid,
    outcome: 'failure',
    what_happened: 'Brave Browser crashed during navigation',
    what_failed: 'Browser crash',
    anti_pattern: 'Brave may crash with too many tabs',
    confidence: 0.3
  });
  const refResults = store.searchReflections('Brave Browser crash');
  assert(refResults.length > 0, 'searchReflections returns results');
  assert(typeof refResults[0].relevance === 'number', 'searchReflections includes relevance score');
  assert(refResults[0].relevance > 0, 'relevance score is positive');

  memory.close();
}

// ══════════════════════════════════════════════════════════
// RUN ALL
// ══════════════════════════════════════════════════════════

console.log('Memory Engine — Test Suite\n');

cleanup();

try {
  testTokenizer();
  testGuards();
  testStore();
  testSkills();
  testReflections();
  testClassify();
  testFlags();
  testReflection();
  testProfile();
  testRetrieval();
  testPiggyAdapter();
  testStats();
  testEdgeCases();
} catch (err) {
  console.error(`\n[CRASH in ${currentSection}]`, err);
  failed++;
} finally {
  cleanup();
}

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
