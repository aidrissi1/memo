/**
 * Memory Engine — Reflect
 * Post-task reasoning chain. After a task ends, the model reflects on
 * what happened using structured, constrained prompts.
 *
 * The reflection produces:
 *   - what_happened: factual summary from executor feedback
 *   - what_worked / what_failed: grounded in executor data
 *   - strategy: compressed reusable procedure (success only)
 *   - anti_pattern: what to avoid (grounded in actual errors)
 *
 * Reflections start at low confidence (0.3–0.4). They gain confidence
 * when the strategy works in future tasks.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const store = require('./store');

// ── Reflection Prompt Builder ────────────────────────────

/**
 * Build a constrained reflection prompt from a completed session.
 *
 * @param {number} sessionId
 * @returns {{ prompt: string, sessionData: object }|null}
 */
function buildReflectionPrompt(sessionId) {
  const session = store.getSession(sessionId);
  if (!session) return null;

  const memories = store.getMemories(sessionId);
  if (!memories.length) return null;

  // Build factual timeline from executor feedback (ground truth)
  const timeline = [];
  for (const m of memories) {
    if (m.type === 'task') continue;
    const stepLabel = m.step ? `Step ${m.step}` : '';
    const typeLabel = m.type.toUpperCase();
    timeline.push(`${stepLabel} [${typeLabel}]: ${m.content}`);
  }

  // No executor data to reflect on
  if (!timeline.length) return null;

  const actions = memories.filter(m => m.type === 'action');
  const observations = memories.filter(m => m.type === 'observation');
  const errors = memories.filter(m => m.type === 'error');
  const results = memories.filter(m => m.type === 'result');

  const prompt = `You are reflecting on a completed task. Analyze ONLY what actually happened based on the executor feedback below. Do NOT invent explanations for things you don't have data for.

TASK: "${session.task}"
OUTCOME: ${session.outcome}
STEPS: ${session.step_count}

TIMELINE (from executor — this is ground truth):
${timeline.join('\n')}

SUMMARY:
- ${actions.length} actions attempted
- ${observations.length} confirmed observations from executor
- ${errors.length} errors reported by executor
- ${results.length} results

Respond with ONLY valid JSON matching this exact structure:
{
  "what_happened": "Brief factual summary of what occurred (2-3 sentences max)",
  "what_worked": "What strategies or actions led to progress (null if nothing worked)",
  "what_failed": "What went wrong, based ONLY on executor errors above (null if nothing failed)",
  "strategy": "If successful: a reusable step-by-step procedure for similar tasks, using semantic descriptions not pixel coordinates. If failed: null",
  "strategy_name": "Short name for the strategy (e.g. 'Navigate to URL in Brave'). null if no strategy",
  "strategy_steps": ["Step 1 description", "Step 2 description"],
  "app_context": "Which app this applies to (null if general)",
  "anti_pattern": "What to avoid next time, based ONLY on actual errors listed above (null if no clear anti-pattern)",
  "preconditions": "What needs to be true before this strategy works (null if none)"
}

RULES:
- Use SEMANTIC descriptions: "focus the address bar" not "click at (400, 50)"
- Reference UI elements by NAME or ROLE: "the search input" not coordinates
- Only claim things supported by the executor feedback above
- If you're unsure why something failed, say "unclear from executor data" not a guess
- Keep strategy steps generic enough to work on any screen size
- strategy_steps MUST be an array of strings, not a single string`;

  return {
    prompt,
    sessionData: {
      session,
      memories,
      actionCount: actions.length,
      errorCount: errors.length,
      observationCount: observations.length
    }
  };
}

// ── Process Reflection Response ──────────────────────────

/**
 * Parse the model's reflection response and store it.
 * Also creates a skill if the reflection includes a valid strategy.
 *
 * @param {number} sessionId
 * @param {string} modelResponse — raw JSON string from the model
 * @returns {{ reflection: object, skill: object|null }|null}
 */
function processReflection(sessionId, modelResponse) {
  if (!modelResponse || typeof modelResponse !== 'string') return null;

  // Non-greedy: match the first complete JSON object
  const match = modelResponse.match(/\{[\s\S]*?\}(?=[^}]*$)|\{[\s\S]*\}/);
  if (!match) return null;

  // Try to parse — find valid JSON by trimming from the end if needed
  let parsed = null;
  const raw = match[0];
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    // Try to find a valid JSON substring
    const braceIdx = raw.indexOf('{');
    if (braceIdx >= 0) {
      // Find matching closing brace
      let depth = 0;
      for (let i = braceIdx; i < raw.length; i++) {
        if (raw[i] === '{') depth++;
        if (raw[i] === '}') depth--;
        if (depth === 0) {
          try { parsed = JSON.parse(raw.substring(braceIdx, i + 1)); } catch (_2) {}
          break;
        }
      }
    }
  }

  if (!parsed || !parsed.what_happened) return null;

  const session = store.getSession(sessionId);
  if (!session) return null;

  // Confidence based on outcome
  const baseConfidence = session.outcome === 'success' ? 0.4 : 0.25;

  // Store reflection
  const reflectionId = store.addReflection({
    session_id: sessionId,
    outcome: session.outcome || 'unknown',
    what_happened: parsed.what_happened,
    what_worked: parsed.what_worked || null,
    what_failed: parsed.what_failed || null,
    strategy: parsed.strategy || null,
    anti_pattern: parsed.anti_pattern || null,
    confidence: baseConfidence
  });

  const reflection = store.getReflection(reflectionId);
  let skill = null;

  // Create skill from successful strategies
  if (session.outcome === 'success' && parsed.strategy_name && parsed.strategy_steps) {
    const steps = Array.isArray(parsed.strategy_steps)
      ? parsed.strategy_steps.filter(s => typeof s === 'string' && s.length > 0)
      : [];

    if (steps.length > 0) {
      const existing = store.findSkillByName(parsed.strategy_name);
      if (existing) {
        store.reinforceSkill(existing.id);
        skill = store.getSkill(existing.id);
      } else {
        // Skill inherits reflection confidence, not lower
        const skillId = store.addSkill({
          name: parsed.strategy_name,
          description: parsed.strategy || parsed.what_worked || '',
          steps,
          preconditions: parsed.preconditions || null,
          app_context: parsed.app_context || null,
          confidence: baseConfidence,
          source_session_id: sessionId
        });
        skill = store.getSkill(skillId);
      }
    }
  }

  return { reflection, skill };
}

module.exports = {
  buildReflectionPrompt,
  processReflection
};
