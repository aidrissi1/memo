/**
 * Memory Engine — Flags
 * Detects context loss during an AI task.
 *
 * Four detectors:
 *   1. Repetition   — same action attempted N times in a row
 *   2. Contradiction — model says "done" then keeps going
 *   3. Loop          — model alternates between the same actions
 *   4. Redundancy    — model re-does something already confirmed successful
 *
 * Each detector returns { flagged, type, detail } or null.
 * The engine calls checkAll() after every model response.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

// ── Repetition Detector ──────────────────────────────────
// Fires when the last N actions are effectively identical.

function detectRepetition(memories, threshold) {
  threshold = (typeof threshold === 'number' && threshold >= 2) ? threshold : 3;
  const actions = memories.filter(m => m.type === 'action');
  if (actions.length < threshold) return null;

  const recent = actions.slice(-threshold);
  const normalized = recent.map(a => normalizeAction(a.content));

  const allSame = normalized.every(n => n === normalized[0]);
  if (allSame) {
    return {
      flagged: true,
      type: 'repetition',
      detail: `Same action repeated ${threshold}x: "${recent[0].content}"`,
      count: threshold
    };
  }

  return null;
}

// ── Contradiction Detector ───────────────────────────────
// Fires when model claims "done"/"success" then keeps acting.

const DONE_PATTERNS = [
  /\btask completed\b/i, /\bdone\b/i, /\bfinished\b/i, /\bsuccessfully\b/i
];

function detectContradiction(memories) {
  const relevant = memories.filter(m => m.type === 'result' || m.type === 'action');
  if (relevant.length < 4) return null;

  const recent = relevant.slice(-8);

  // Pattern: said "done" or "success" in a result, then kept acting
  for (let i = 0; i < recent.length - 1; i++) {
    const curr = recent[i];
    const next = recent[i + 1];

    if (curr.type === 'result' && DONE_PATTERNS.some(p => p.test(curr.content))) {
      if (next.type === 'action') {
        return {
          flagged: true,
          type: 'contradiction',
          detail: `Claimed done ("${curr.content.slice(0, 60)}") but continued acting`
        };
      }
    }
  }

  return null;
}

// ── Loop Detector ────────────────────────────────────────
// Fires when model alternates between the same actions (A→B→A→B).

function detectLoop(memories) {
  const actions = memories.filter(m => m.type === 'action');
  if (actions.length < 4) return null;

  const recent = actions.slice(-6);
  const norms = recent.map(a => normalizeAction(a.content));

  // Check for A-B-A-B pattern (alternating)
  if (norms.length >= 4) {
    const a = norms[norms.length - 4];
    const b = norms[norms.length - 3];
    const c = norms[norms.length - 2];
    const d = norms[norms.length - 1];
    if (a === c && b === d && a !== b) {
      return {
        flagged: true,
        type: 'loop',
        detail: `Alternating loop detected: "${recent[recent.length - 4].content}" ↔ "${recent[recent.length - 3].content}"`
      };
    }
  }

  // Check for A-B-C-A-B-C pattern (3-step cycle)
  if (norms.length >= 6) {
    const [a, b, c, d, e, f] = norms.slice(-6);
    if (a === d && b === e && c === f && !(a === b && b === c)) {
      return {
        flagged: true,
        type: 'loop',
        detail: `3-step loop detected over last 6 actions`
      };
    }
  }

  return null;
}

// ── Redundancy Detector ──────────────────────────────────
// Fires when model re-does an action that already had a confirmed
// successful observation afterwards.

function detectRedundancy(memories) {
  const actions = [];
  const actionIndices = [];

  // Build action list with their indices in the full memory array
  for (let i = 0; i < memories.length; i++) {
    if (memories[i].type === 'action') {
      actions.push(memories[i]);
      actionIndices.push(i);
    }
  }

  if (actions.length < 2) return null;

  const last = actions[actions.length - 1];
  const lastNorm = normalizeAction(last.content);
  const lastIdx = actionIndices[actionIndices.length - 1];

  // Check if this exact action was already done AND had a success observation after it
  for (let i = 0; i < actions.length - 1; i++) {
    if (normalizeAction(actions[i].content) !== lastNorm) continue;

    const thisIdx = actionIndices[i];

    // Look for a success observation between this action and the next action
    const nextActionIdx = (i + 1 < actionIndices.length) ? actionIndices[i + 1] : memories.length;
    for (let j = thisIdx + 1; j < nextActionIdx; j++) {
      if (memories[j].type === 'observation' && isSuccessObservation(memories[j].content)) {
        return {
          flagged: true,
          type: 'redundancy',
          detail: `Re-doing action that already succeeded: "${last.content.slice(0, 60)}"`
        };
      }
    }
  }

  return null;
}

// ── Check All ────────────────────────────────────────────

function checkAll(memories, opts = {}) {
  if (!Array.isArray(memories) || !memories.length) return [];

  const flags = [];

  const rep = detectRepetition(memories, opts.repetitionThreshold);
  if (rep) flags.push(rep);

  const con = detectContradiction(memories);
  if (con) flags.push(con);

  const loop = detectLoop(memories);
  if (loop) flags.push(loop);

  const red = detectRedundancy(memories);
  if (red) flags.push(red);

  return flags;
}

// ── Helpers ──────────────────────────────────────────────

/**
 * Normalize an action description for comparison.
 * Preserves word boundaries (splits on non-alphanumeric), lowercases, trims.
 */
function normalizeAction(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if an observation describes a successful outcome.
 * Uses word-boundary matching to avoid "not loaded" matching "loaded".
 */
function isSuccessObservation(text) {
  if (!text) return false;
  const t = text.toLowerCase();

  // Reject if negation words appear before success keywords
  const NEGATIONS = /\b(not|no|never|failed to|unable to|didn't|couldn't|wasn't|isn't|can't)\b/i;
  if (NEGATIONS.test(t)) return false;

  // Word-boundary success patterns
  const SUCCESS = /\b(success|confirmed|visible|appeared|loaded|clicked|focused|opened|completed|found)\b/i;
  return SUCCESS.test(t);
}

module.exports = { checkAll, detectRepetition, detectContradiction, detectLoop, detectRedundancy, isSuccessObservation };
