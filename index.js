/**
 * Memory Engine
 * Persistent AI memory with skills, reflections, and confidence scoring.
 *
 * Architecture:
 *   Experience Log  — raw actions/observations/errors per session (ground truth)
 *   Reflections     — model's post-task reasoning (low confidence until confirmed)
 *   Skills          — compressed reusable strategies (promoted from reflections)
 *   Profile         — dynamic agent identity built from accumulated knowledge
 *   Recall          — model-driven search across all knowledge layers
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const store = require('./store');
const flags = require('./flags');
const retrieval = require('./retrieval');
const reflect = require('./reflect');
const profile = require('./profile');

let initialized = false;

// ── Lifecycle ────────────────────────────────────────────

function init(dbPath) {
  store.init(dbPath);
  initialized = true;
}

function close() {
  store.close();
  initialized = false;
}

function assertReady() {
  if (!initialized) throw new Error('Memory engine not initialized. Call memory.init() first.');
}

// ── Session Management ───────────────────────────────────

function startSession(task, metadata) {
  assertReady();
  return store.createSession(task, metadata);
}

function endSession(sessionId, outcome, stepCount) {
  assertReady();
  store.endSession(sessionId, outcome, stepCount);
}

// ── Experience Log ───────────────────────────────────────

function storeMemory(sessionId, type, content, step) {
  assertReady();
  return store.addMemory(sessionId, type, content, step);
}

function classifyAndStore(sessionId, action, step) {
  assertReady();
  if (!action || typeof action !== 'object') {
    return storeMemory(sessionId, 'error', 'Invalid action: ' + JSON.stringify(action), step);
  }
  const desc = describeAction(action);
  switch (action.action) {
    case 'done':
      return storeMemory(sessionId, 'result', `Task completed: ${action.reason || 'no reason'}`, step);
    case 'fail':
      return storeMemory(sessionId, 'error', `Task failed: ${action.reason || 'no reason'}`, step);
    default:
      return storeMemory(sessionId, 'action', desc, step);
  }
}

function storeObservation(sessionId, description, step) {
  assertReady();
  return storeMemory(sessionId, 'observation', description, step);
}

function storeError(sessionId, description, step) {
  assertReady();
  return storeMemory(sessionId, 'error', description, step);
}

// ── Flag Detection ───────────────────────────────────────

function checkFlags(sessionId, opts) {
  assertReady();
  const memories = store.getMemories(sessionId);
  return flags.checkAll(memories, opts);
}

// ── Reflection ───────────────────────────────────────────

/**
 * Build a constrained reflection prompt for a completed session.
 * Send this to the model, then pass the response to processReflection().
 *
 * @param {number} sessionId
 * @returns {{ prompt: string, sessionData: object }|null}
 */
function getReflectionPrompt(sessionId) {
  assertReady();
  return reflect.buildReflectionPrompt(sessionId);
}

/**
 * Process the model's reflection response.
 * Stores the reflection and creates a skill if applicable.
 *
 * @param {number} sessionId
 * @param {string} modelResponse — raw JSON from the model
 * @returns {{ reflection: object, skill: object|null }|null}
 */
function processReflection(sessionId, modelResponse) {
  assertReady();
  return reflect.processReflection(sessionId, modelResponse);
}

// ── Skills ───────────────────────────────────────────────

function getSkills(limit) {
  assertReady();
  return store.getTopSkills(limit);
}

function getSkillsByApp(app, limit) {
  assertReady();
  return store.getSkillsByApp(app, limit);
}

function searchSkills(query, opts) {
  assertReady();
  return store.searchSkills(query, opts);
}

function reinforceSkill(skillId) {
  assertReady();
  store.reinforceSkill(skillId);
}

function weakenSkill(skillId) {
  assertReady();
  store.weakenSkill(skillId);
}

// ── Recall (model-driven search) ─────────────────────────

/**
 * Search across all knowledge layers.
 * Called when the model uses the "recall" action.
 *
 * @param {string} query — what the model wants to remember
 * @param {object} [opts]
 * @returns {Array}
 */
function recall(query, opts) {
  assertReady();
  return retrieval.recall(query, opts);
}

/**
 * Build a formatted recall response to inject into conversation.
 *
 * @param {string} query
 * @param {object} [opts]
 * @returns {string}
 */
function recallFormatted(query, opts) {
  assertReady();
  return retrieval.buildRecallResponse(query, opts);
}

// ── Profile ──────────────────────────────────────────────

/**
 * Generate the full agent identity prompt.
 * Inject this into the system prompt.
 */
function getProfile(opts) {
  assertReady();
  return profile.buildProfile(opts);
}

/**
 * Generate task-specific context (skills + warnings for this task).
 * Smaller than full profile — append to system prompt for relevant tasks.
 */
function getTaskContext(task, opts) {
  assertReady();
  return profile.buildTaskContext(task, opts);
}

// ── Stats & History ──────────────────────────────────────

function stats() {
  assertReady();
  return store.stats();
}

function getSessionMemories(sessionId) {
  assertReady();
  return store.getMemories(sessionId);
}

function getRecentSessions(limit) {
  assertReady();
  return store.getRecentSessions(limit);
}

// ── Helpers ──────────────────────────────────────────────

function describeAction(action) {
  const el = action._matched ? ` "${action._matched}"` : '';
  switch (action.action) {
    case 'click':       return `click_element${el}` + (el ? '' : ` at (${action.x}, ${action.y})`);
    case 'click_type':  return `click_and_type${el} text="${(action.text || '').slice(0, 60)}"`;
    case 'right_click': return `right_click${el}` + (el ? '' : ` at (${action.x}, ${action.y})`);
    case 'type':        return `type "${(action.text || '').slice(0, 80)}"`;
    case 'key':         return `press_key ${action.key}`;
    case 'shortcut':    return `keyboard_shortcut ${[...(action.modifiers || []), action.key].join('+')}`;
    case 'scroll':      return `scroll_page ${action.direction || 'down'}`;
    case 'navigate':    return `navigate_to ${action.url || ''}`;
    case 'focus':       return `focus_app ${action.app}`;
    case 'read':        return `read_page`;
    case 'screenshot':  return `take_screenshot`;
    case 'web_search':  return `web_search "${action.query || ''}"`;
    case 'recall':      return `recall_memory "${action.query || ''}"`;
    case 'done':        return `task_complete: ${action.reason || ''}`;
    case 'fail':        return `task_failed: ${action.reason || ''}`;
    default:            return `${action.action}: ${JSON.stringify(action).slice(0, 100)}`;
  }
}

module.exports = {
  // Lifecycle
  init, close,
  // Sessions
  startSession, endSession,
  // Experience log
  storeMemory, classifyAndStore, storeObservation, storeError,
  // Flags
  checkFlags,
  // Reflection
  getReflectionPrompt, processReflection,
  // Skills
  getSkills, getSkillsByApp, searchSkills, reinforceSkill, weakenSkill,
  // Recall
  recall, recallFormatted,
  // Profile
  getProfile, getTaskContext,
  // Stats & history
  stats, getSessionMemories, getRecentSessions,
  // Constants
  TYPES: store.VALID_TYPES,
  OUTCOMES: store.VALID_OUTCOMES
};
