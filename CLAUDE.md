# Memory Engine — Development Guide

## What this is
Zero-dependency persistent AI memory system. SQLite-backed (node:sqlite). Used by Piggy via adapters/piggy.js.

## Architecture
- `store.js` — SQLite layer. 4 tables: sessions, memories, skills, reflections.
- `index.js` — Public API facade. All external calls go through here.
- `flags.js` — Context loss detection: repetition, contradiction, loops, redundancy.
- `reflect.js` — Post-task reflection prompt builder + response parser. Extracts tool-call format skills.
- `profile.js` — Dynamic agent identity prompt generation.
- `retrieval.js` — Multi-layer recall: skills > reflections > raw memories.
- `adapters/piggy.js` — Drop-in integration with Piggy's ai-controller.

## Critical rules
- Requires Node 22.5+ for `node:sqlite`. No npm dependencies.
- `describeAction()` MUST preserve `_matched` element names from Piggy actions.
- Skills store tool-call format steps, not prose. Example: `"click_and_type "Search" text={{query}}"`.
- `app_context` for any browser task MUST be `"browser"` (not "Safari" or "Brave Browser").
- Confidence: +0.1 reinforce, -0.1 weaken, floor 0.05, ceiling 1.0. Symmetric.
- `searchSkills` normalizes browser names for cross-browser matching.

## Testing
- `node test.js` — 43+ tests (requires Node 22+)
- Tests create/destroy temp SQLite DB automatically

## Style
- CommonJS, no TypeScript, no external deps
- Apache-2.0 license
- Author: Idrissi
