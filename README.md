# Memory Engine

Persistent memory for AI agents. Classifies and stores conversation history, detects context loss mid-task, and retrieves relevant past experience using multi-strategy search.

Built for [Piggy](https://github.com/aidrissi1/Piggy), works with anything.

## What it does

### Tested and working
- **Classify & Store** — every action, observation, result, and error gets typed and saved to SQLite
- **Context Loss Detection** — three detectors run after each model response:
  - **Repetition** — same action attempted N times in a row
  - **Contradiction** — model claims "done" then keeps acting, or retries a declared-failed action
  - **Redundancy** — model re-does something that already succeeded
- **Multi-Strategy Retrieval** — finds relevant memories using:
  - Keyword matching (token overlap)
  - Recency weighting (newer = higher rank)
  - Type boosting (error queries surface errors, how-to queries surface learnings)
  - Frequency scoring (learnings that keep getting reused rank higher)
- **Learnings** — distilled patterns extracted from successful tasks, persisted and boosted over time
- **Context Injection** — builds a formatted block of relevant past experience to append to AI system prompts
- **Piggy Adapter** — drop-in integration for Piggy's ai-controller.js

## Install

```bash
npm install
```

Requires Node.js. The only dependency is `better-sqlite3`.

## Usage

### Standalone

```js
const memory = require('memory-engine');

memory.init('./memory.db');

// Start a task session
const sid = memory.startSession('Open Brave and search for cats');

// Store classified memories as the AI works
memory.storeMemory(sid, 'action', 'Click at (400, 200)', 1);
memory.storeObservation(sid, 'Search bar is now focused', 1);

// Or classify automatically from model JSON output
memory.classifyAndStore(sid, { action: 'type', text: 'cats' }, 2);

// Check for context loss after each model response
const flags = memory.checkFlags(sid);
// [{ flagged: true, type: 'repetition', detail: '...' }]

// Query relevant past experience for a new task
const context = memory.getContext('Open Brave and search for dogs');
// Returns formatted string to inject into system prompt

// Teach the engine reusable patterns
memory.learn('Brave search bar is at approximately (400, 50)', sid);

// End the session
memory.endSession(sid, 'success', 5);

// Stats
memory.stats();
// { sessions: 12, memories: 89, learnings: 7, successRate: 75 }
```

### With Piggy

```js
const piggyMemory = require('memory-engine/adapters/piggy');

piggyMemory.init('./piggy-memory.db');

// Before task starts — gets past context to inject
const ctx = piggyMemory.beforeTask('Open Brave and go to google.com');
// ctx.sessionId, ctx.systemPromptAppend

// After each model response — classifies, stores, checks flags
const result = piggyMemory.afterStep(ctx.sessionId, parsedAction, step);
// result.flags, result.contextBoost

// When task ends — saves session, extracts learnings
piggyMemory.afterTask(ctx.sessionId, 'success', 5, allActions);
```

## Architecture

```
index.js              — public API: init, store, query, checkFlags, learn
store.js              — SQLite layer: sessions, memories, learnings tables
flags.js              — context loss detection: repetition, contradiction, redundancy
retrieval.js          — multi-strategy search: keyword + recency + type + frequency
adapters/piggy.js     — drop-in integration for Piggy's AI controller
```

### Database schema

**sessions** — one row per task (task description, timestamps, outcome, step count)

**memories** — classified entries within a session (type, content, step, tokenized for search)

**learnings** — distilled reusable patterns with hit counters

### Memory types

| Type | What it stores |
|------|---------------|
| `task` | The original task description |
| `action` | What the agent did (click, type, focus, etc.) |
| `observation` | What the agent saw after acting |
| `result` | Outcome of actions (success, completion) |
| `error` | Failures, missing elements, crashes |
| `learning` | Distilled patterns from experience |

## Tests

```bash
npm test
```

43 tests covering store, tokenizer, classification, flag detection, retrieval, and full task lifecycle.

## What's next

- Embedding search (optional, uses existing model provider)
- Learning extraction from failed tasks (what NOT to do)
- Session similarity scoring (find past tasks most like the current one)
- Memory pruning (auto-clean old low-value memories)

## License

Apache 2.0 — Idrissi
