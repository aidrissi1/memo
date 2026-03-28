/**
 * Memory Engine — Profile
 * Generates a dynamic agent identity prompt from accumulated knowledge.
 *
 * The profile is a formatted text block injected into the system prompt.
 * It tells the model: who you are, what you can do, what you know,
 * what works, what doesn't, and how confident you are.
 *
 * Rebuilt from the database every time — always current.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const store = require('./store');

/**
 * Generate the full agent profile prompt.
 *
 * @param {object} [opts]
 * @param {string} [opts.agentName] — name of the agent (default: 'Piggy')
 * @param {number} [opts.maxSkills] — max skills to include (default: 10)
 * @param {number} [opts.maxAntiPatterns] — max warnings (default: 5)
 * @returns {string} — formatted profile block, empty if no data
 */
function buildProfile(opts = {}) {
  const agentName = opts.agentName || 'Piggy';
  const maxSkills = opts.maxSkills || 10;
  const maxAntiPatterns = opts.maxAntiPatterns || 5;

  const s = store.stats();

  // No history at all — return empty
  if (s.sessions === 0) return '';

  const lines = [];
  lines.push(`[Agent Profile — ${agentName}]`);

  // ── Track Record ────────────────────────────────────
  if (s.successRate !== null) {
    lines.push(`\nTrack record: ${s.successRate}% success rate across ${s.sessions} tasks.`);
  } else {
    lines.push(`\nTasks attempted: ${s.sessions} (no completed tasks yet).`);
  }

  if (s.skills > 0) {
    lines.push(`Known skills: ${s.skills} (${s.confirmedReflections} confirmed through repeated success).`);
  }

  // ── Known Apps ──────────────────────────────────────
  if (s.topApps && s.topApps.length) {
    lines.push('\nApps you have experience with:');
    for (const app of s.topApps) {
      const conf = app.avg_conf != null ? Math.round(app.avg_conf * 100) : 0;
      lines.push(`  - ${app.app_context}: ${app.count} skills, ${conf}% avg confidence`);
    }
  }

  // ── Top Skills ──────────────────────────────────────
  const skills = store.getTopSkills(maxSkills);
  if (skills.length) {
    lines.push('\nSkills you know (use these when relevant):');
    for (const skill of skills) {
      const conf = Math.round(skill.confidence * 100);
      const steps = Array.isArray(skill.steps) ? skill.steps : [];
      const appTag = skill.app_context ? ` [${skill.app_context}]` : '';
      const confTag = conf >= 70 ? ' (reliable)' : conf >= 40 ? ' (developing)' : ' (uncertain)';

      lines.push(`  "${skill.name}"${appTag}${confTag}:`);
      if (skill.preconditions) {
        lines.push(`    Requires: ${skill.preconditions}`);
      }
      for (let i = 0; i < steps.length; i++) {
        lines.push(`    ${i + 1}. ${steps[i]}`);
      }
    }
  }

  // ── Anti-Patterns ──────────────────────────────────
  const antiPatterns = store.getAntiPatterns(maxAntiPatterns);
  if (antiPatterns.length) {
    lines.push('\nThings that have gone wrong before (avoid these):');
    for (const ap of antiPatterns) {
      const conf = Math.round(ap.confidence * 100);
      lines.push(`  - ${ap.anti_pattern} (${conf}% confident this is a real issue)`);
    }
  }

  // ── Guidance ────────────────────────────────────────
  lines.push('\nGuidance:');
  lines.push('- Use the "recall" action to search your memory if you need past experience mid-task.');
  lines.push('- Use "find" (accessibility API) to locate UI elements by name. Do NOT guess pixel coordinates.');
  lines.push('- If a skill exists for your current task, follow it. If it fails, try a different approach.');
  lines.push('- If you get stuck, describe what you see and what you expected. Do not repeat failed actions.');

  lines.push(`\n[End Agent Profile]`);

  return lines.join('\n');
}

/**
 * Generate a compact task-specific context.
 * Smaller than the full profile — just skills and warnings relevant to THIS task.
 *
 * @param {string} task — the current task
 * @param {object} [opts]
 * @param {string} [opts.app] — target app if known
 * @returns {string}
 */
function buildTaskContext(task, opts = {}) {
  const lines = [];

  // Find relevant skills
  const skills = store.searchSkills(task, {
    app: opts.app,
    minConfidence: 0.3,
    limit: 3
  });

  if (skills.length) {
    lines.push('[Relevant skills from past experience]');
    for (const skill of skills) {
      const conf = Math.round(skill.confidence * 100);
      const steps = Array.isArray(skill.steps) ? skill.steps : [];
      lines.push(`"${skill.name}" (${conf}% confidence):`);
      for (let i = 0; i < steps.length; i++) {
        lines.push(`  ${i + 1}. ${steps[i]}`);
      }
    }
  }

  // Find relevant anti-patterns
  const warnings = store.searchReflections(task, {
    outcome: 'failure',
    limit: 3
  }).filter(r => r.anti_pattern);

  if (warnings.length) {
    lines.push('\n[Warnings from past failures]');
    for (const w of warnings) {
      lines.push(`- ${w.anti_pattern}`);
    }
  }

  if (!lines.length) return '';

  lines.push('[End task context]');
  return lines.join('\n');
}

module.exports = { buildProfile, buildTaskContext };
