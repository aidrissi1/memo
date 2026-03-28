/**
 * Memory Engine — Retrieval
 * Searches across skills, reflections, and raw memories.
 *
 * Three search targets (in priority order):
 *   1. Skills — compressed strategies with confidence scores
 *   2. Reflections — post-task reasoning with anti-patterns
 *   3. Memories — raw experience log (fallback)
 *
 * Used by the recall action — the model searches its own memory mid-task.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const store = require('./store');

/**
 * Search across all knowledge layers.
 * Skills are prioritized over reflections, reflections over raw memories.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {string} [opts.app] — filter to specific app
 * @param {number} [opts.limit] — max results (default 8)
 * @param {boolean} [opts.includeRawMemories] — search raw experience log too (default false)
 * @returns {Array<{source, content, confidence, type}>}
 */
function recall(query, opts = {}) {
  const limit = opts.limit || 8;
  const results = [];

  // Layer 1: Skills
  const skills = store.searchSkills(query, {
    app: opts.app,
    minConfidence: 0.2,
    limit: Math.ceil(limit / 2)
  });

  for (const skill of skills) {
    results.push({
      source: 'skill',
      id: skill.id,
      name: skill.name,
      content: formatSkill(skill),
      confidence: skill.confidence,
      app: skill.app_context,
      type: 'strategy'
    });
  }

  // Layer 2: Reflections (anti-patterns and strategies)
  const reflections = store.searchReflections(query, {
    limit: Math.ceil(limit / 3)
  });

  for (const ref of reflections) {
    if (ref.anti_pattern) {
      results.push({
        source: 'reflection',
        id: ref.id,
        name: null,
        content: `WARNING: ${ref.anti_pattern}`,
        confidence: ref.confidence,
        app: null,
        type: 'anti_pattern'
      });
    }
    if (ref.strategy && ref.outcome === 'success') {
      results.push({
        source: 'reflection',
        id: ref.id,
        name: null,
        content: ref.strategy,
        confidence: ref.confidence,
        app: null,
        type: 'strategy'
      });
    }
  }

  // Layer 3: Raw memories (only if requested or nothing else found)
  if (opts.includeRawMemories || results.length === 0) {
    const memories = store.searchMemories(query, {
      limit: Math.min(limit, 5)
    });

    for (const mem of memories) {
      if (mem.relevance < 0.2) continue;
      results.push({
        source: 'memory',
        id: mem.id,
        name: null,
        content: `[${mem.type}] ${mem.content}`,
        confidence: mem.relevance,
        app: null,
        type: mem.type
      });
    }
  }

  // Sort: skills first (highest confidence), then reflections, then memories
  results.sort((a, b) => {
    const sourcePriority = { skill: 3, reflection: 2, memory: 1 };
    const aPri = sourcePriority[a.source] || 0;
    const bPri = sourcePriority[b.source] || 0;
    if (aPri !== bPri) return bPri - aPri;
    return b.confidence - a.confidence;
  });

  return results.slice(0, limit);
}

/**
 * Build a formatted context string from recall results.
 * This is what gets injected into the conversation.
 *
 * @param {string} query
 * @param {object} [opts]
 * @returns {string}
 */
function buildRecallResponse(query, opts = {}) {
  const results = recall(query, opts);
  if (!results.length) return 'No relevant memories found.';

  const lines = ['[Memory recall results]'];

  const skills = results.filter(r => r.source === 'skill');
  const warnings = results.filter(r => r.type === 'anti_pattern');
  const strategies = results.filter(r => r.source === 'reflection' && r.type === 'strategy');
  const raw = results.filter(r => r.source === 'memory');

  if (skills.length) {
    lines.push('\nKnown skills:');
    for (const s of skills) {
      lines.push(s.content);
    }
  }

  if (warnings.length) {
    lines.push('\nWarnings:');
    for (const w of warnings) {
      lines.push(`  ${w.content}`);
    }
  }

  if (strategies.length) {
    lines.push('\nPast strategies:');
    for (const s of strategies) {
      lines.push(`  - ${s.content}`);
    }
  }

  if (raw.length) {
    lines.push('\nRaw experience:');
    for (const m of raw) {
      lines.push(`  ${m.content}`);
    }
  }

  lines.push('[End recall]');
  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────

function formatSkill(skill) {
  const conf = Math.round(skill.confidence * 100);
  const steps = Array.isArray(skill.steps) ? skill.steps : [];
  const appTag = skill.app_context ? ` [${skill.app_context}]` : '';

  let out = `"${skill.name}"${appTag} (${conf}% confidence):`;
  if (skill.preconditions) out += `\n  Requires: ${skill.preconditions}`;
  for (let i = 0; i < steps.length; i++) {
    out += `\n  ${i + 1}. ${steps[i]}`;
  }
  return out;
}

module.exports = { recall, buildRecallResponse };
