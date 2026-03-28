/**
 * Memory Engine — Piggy Adapter
 * Integration layer for Piggy's ai-controller.js.
 *
 * Lifecycle:
 *   1. init()           — once at app start
 *   2. beforeTask()     — returns session ID + profile + task context
 *   3. afterStep()      — classify action, check flags, handle recall
 *   4. onStepResult()   — store executor feedback (ground truth)
 *   5. afterTask()      — end session, get reflection prompt
 *   6. onReflection()   — process model's reflection, create skills
 *
 * New action: "recall"
 *   When the model outputs {"action":"recall","query":"..."}, the adapter
 *   searches the skill library and returns results to inject into the
 *   next message. The model drives its own memory retrieval.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const memory = require('../index');

// ── Lifecycle ────────────────────────────────────────────

function init(dbPath) {
  memory.init(dbPath);
}

function close() {
  memory.close();
}

/**
 * Call before starting a new task.
 *
 * Returns:
 *   - sessionId: track this task
 *   - profile: full agent identity prompt (append to system prompt)
 *   - taskContext: skills + warnings specific to this task
 *   - activeSkills: skill IDs being used (for reinforcement after task)
 */
function beforeTask(task, metadata) {
  const sessionId = memory.startSession(task, metadata);
  memory.storeMemory(sessionId, 'task', task, 0);

  // Build agent profile (who am I, what do I know)
  const profileBlock = memory.getProfile({
    agentName: (metadata && metadata.agentName) || 'Piggy'
  });

  // Build task-specific context (relevant skills + warnings)
  const taskContext = memory.getTaskContext(task, {
    app: metadata && metadata.app
  });

  // Find skills that match this task for later reinforcement
  const matchedSkills = memory.searchSkills(task, {
    app: metadata && metadata.app,
    minConfidence: 0.3,
    limit: 3
  });
  const activeSkillIds = matchedSkills.map(s => s.id);

  return {
    sessionId,
    profile: profileBlock,
    taskContext,
    activeSkillIds
  };
}

/**
 * Call after each model response, BEFORE execution.
 *
 * If the action is "recall", returns the recall results instead of
 * executing. The caller should inject recallResult into the next message.
 *
 * @param {number} sessionId
 * @param {object|object[]} parsedAction
 * @param {number} step
 * @returns {{ flags, contextBoost, isRecall, recallResult }}
 */
function afterStep(sessionId, parsedAction, step) {
  const actions = Array.isArray(parsedAction) ? parsedAction : [parsedAction];

  // Check for recall action
  for (const action of actions) {
    if (action && action.action === 'recall' && action.query) {
      memory.classifyAndStore(sessionId, action, step);
      const recallResult = memory.recallFormatted(action.query, {
        app: action.app || null
      });
      return {
        flags: [],
        contextBoost: '',
        isRecall: true,
        recallResult
      };
    }
  }

  // Classify and store all actions
  for (const action of actions) {
    if (action && typeof action === 'object') {
      memory.classifyAndStore(sessionId, action, step);
    }
  }

  // Check for context loss
  const flagResults = memory.checkFlags(sessionId);

  let contextBoost = '';
  if (flagResults.length > 0) {
    const mems = memory.getSessionMemories(sessionId);
    const taskMem = mems.find(m => m.type === 'task');
    if (taskMem) {
      const recalled = memory.recallFormatted(taskMem.content, { limit: 3 });
      const warnings = flagResults.map(f => `WARNING: ${f.type} — ${f.detail}`).join('\n');
      contextBoost = warnings + '\n\n' + recalled;
    } else {
      contextBoost = flagResults.map(f => `WARNING: ${f.type} — ${f.detail}`).join('\n');
    }
  }

  return {
    flags: flagResults,
    contextBoost,
    isRecall: false,
    recallResult: null
  };
}

/**
 * Call AFTER the executor runs each action.
 * This is ground truth — what actually happened.
 */
function onStepResult(sessionId, action, success, detail, step) {
  if (success && detail) {
    memory.storeObservation(sessionId, detail, step);
  } else if (!success) {
    memory.storeError(sessionId, detail || `Action failed: ${action?.action || 'unknown'}`, step);
  }
}

/**
 * Call when task ends.
 * Returns a reflection prompt to send to the model.
 *
 * @param {number} sessionId
 * @param {'success'|'failure'|'stopped'} outcome
 * @param {number} stepCount
 * @param {number[]} [activeSkillIds] — skills that were matched for this task
 * @returns {{ reflectionPrompt: string|null }}
 */
function afterTask(sessionId, outcome, stepCount, activeSkillIds) {
  memory.endSession(sessionId, outcome, stepCount);

  // Reinforce or weaken skills that were active during this task
  if (activeSkillIds && activeSkillIds.length) {
    for (const skillId of activeSkillIds) {
      if (outcome === 'success') {
        memory.reinforceSkill(skillId);
      } else if (outcome === 'failure') {
        memory.weakenSkill(skillId);
      }
    }
  }

  // Build reflection prompt for the model to think about what happened
  const reflectionData = memory.getReflectionPrompt(sessionId);

  return {
    reflectionPrompt: reflectionData ? reflectionData.prompt : null
  };
}

/**
 * Call after the model responds to the reflection prompt.
 * Processes the reflection, stores it, and creates skills.
 *
 * @param {number} sessionId
 * @param {string} modelResponse — the model's JSON reflection
 * @returns {{ reflection: object, skill: object|null }|null}
 */
function onReflection(sessionId, modelResponse) {
  return memory.processReflection(sessionId, modelResponse);
}

// ── Utilities ────────────────────────────────────────────

function getStats() {
  try { return memory.stats(); } catch (_) { return null; }
}

function getHistory(limit) {
  try { return memory.getRecentSessions(limit); } catch (_) { return []; }
}

function getSkills(limit) {
  try { return memory.getSkills(limit); } catch (_) { return []; }
}

module.exports = {
  init, close,
  beforeTask, afterStep, onStepResult, afterTask, onReflection,
  getStats, getHistory, getSkills
};
