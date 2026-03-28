/**
 * Memory Engine — Store
 * SQLite persistence layer using Node's built-in node:sqlite (no native addons).
 *
 * Tables:
 *   sessions     — one row per task run
 *   memories     — classified entries within a session (the raw experience log)
 *   skills       — compressed reusable strategies with confidence scoring
 *   reflections  — model's post-task reasoning (low confidence until confirmed)
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

let db = null;

const VALID_TYPES = ['task', 'action', 'observation', 'result', 'error'];
const VALID_OUTCOMES = ['success', 'failure', 'stopped', 'unknown'];

function utcNow() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
}

// ── Schema ───────────────────────────────────────────────
// node:sqlite doesn't support datetime() in DEFAULT, so timestamps are set in JS.

const TABLES = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task        TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    outcome     TEXT DEFAULT 'unknown',
    step_count  INTEGER DEFAULT 0,
    metadata    TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS memories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL,
    type        TEXT NOT NULL,
    content     TEXT NOT NULL,
    step        INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL,
    tokens      TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS skills (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,
    description     TEXT NOT NULL,
    steps           TEXT NOT NULL,
    preconditions   TEXT,
    app_context     TEXT,
    confidence      REAL DEFAULT 0.3 CHECK(confidence >= 0.0 AND confidence <= 1.0),
    source_session_id INTEGER,
    created_at      TEXT NOT NULL,
    last_used_at    TEXT,
    tokens          TEXT,
    FOREIGN KEY (source_session_id) REFERENCES sessions(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reflections (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      INTEGER NOT NULL,
    outcome         TEXT NOT NULL,
    what_happened   TEXT NOT NULL,
    what_worked     TEXT,
    what_failed     TEXT,
    strategy        TEXT,
    anti_pattern    TEXT,
    confidence      REAL DEFAULT 0.3 CHECK(confidence >= 0.0 AND confidence <= 1.0),
    confirmed       INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL,
    tokens          TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )`
];

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_memories_session    ON memories(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_memories_type       ON memories(type)',
  'CREATE INDEX IF NOT EXISTS idx_memories_created    ON memories(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_started    ON sessions(started_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_skills_confidence   ON skills(confidence DESC)',
  'CREATE INDEX IF NOT EXISTS idx_skills_app          ON skills(app_context)',
  'CREATE INDEX IF NOT EXISTS idx_reflections_session ON reflections(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_reflections_conf    ON reflections(confidence DESC)'
];

// ── Init ─────────────────────────────────────────────────

function init(dbPath) {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  const resolved = dbPath || path.join(process.cwd(), 'memory.db');
  db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of TABLES) db.exec(sql);
  for (const sql of INDEXES) db.exec(sql);
}

function close() {
  if (db) { try { db.close(); } catch (_) {} db = null; }
}

function getDb() {
  if (!db) throw new Error('Store not initialized. Call store.init() first.');
  return db;
}

// ── Sessions ─────────────────────────────────────────────

function createSession(task, metadata) {
  let meta = null;
  if (metadata != null) {
    try { meta = JSON.stringify(metadata); } catch (_) { meta = null; }
  }
  return getDb().prepare(
    'INSERT INTO sessions (task, started_at, metadata) VALUES (?, ?, ?)'
  ).run(task, utcNow(), meta).lastInsertRowid;
}

function endSession(sessionId, outcome, stepCount) {
  if (outcome && !VALID_OUTCOMES.includes(outcome)) {
    throw new Error(`Invalid outcome: ${outcome}. Must be one of: ${VALID_OUTCOMES.join(', ')}`);
  }
  getDb().prepare(
    'UPDATE sessions SET ended_at = ?, outcome = ?, step_count = ? WHERE id = ?'
  ).run(utcNow(), outcome || 'unknown', stepCount || 0, sessionId);
}

function getSession(sessionId) {
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!row) return null;
  if (row.metadata) {
    try { row.metadata = JSON.parse(row.metadata); } catch (_) { row.metadata = null; }
  }
  return row;
}

function getRecentSessions(limit) {
  const rows = getDb().prepare(
    'SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?'
  ).all(limit || 20);
  for (const row of rows) {
    if (row.metadata) {
      try { row.metadata = JSON.parse(row.metadata); } catch (_) { row.metadata = null; }
    }
  }
  return rows;
}

// ── Memories (experience log) ────────────────────────────

function addMemory(sessionId, type, content, step) {
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`Invalid memory type: ${type}. Must be one of: ${VALID_TYPES.join(', ')}`);
  }
  const tokens = tokenize(content);
  return getDb().prepare(
    'INSERT INTO memories (session_id, type, content, step, created_at, tokens) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sessionId, type, content, step || 0, utcNow(), tokens).lastInsertRowid;
}

function getMemories(sessionId) {
  return getDb().prepare(
    'SELECT * FROM memories WHERE session_id = ? ORDER BY step ASC, id ASC'
  ).all(sessionId);
}

function getMemoriesByType(type, limit) {
  return getDb().prepare(
    'SELECT * FROM memories WHERE type = ? ORDER BY created_at DESC LIMIT ?'
  ).all(type, limit || 50);
}

function searchMemories(query, opts = {}) {
  const words = tokenizeToArray(query);
  if (!words.length) return [];

  const conditions = words.map(() => 'instr(tokens, ?) > 0');
  const params = words.slice();

  let sql = `SELECT *, 0 as relevance FROM memories WHERE (${conditions.join(' OR ')})`;
  if (opts.type) { sql += ' AND type = ?'; params.push(opts.type); }
  if (opts.sessionId) { sql += ' AND session_id = ?'; params.push(opts.sessionId); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(opts.limit || 30);

  const rows = getDb().prepare(sql).all(...params);

  for (const row of rows) {
    let score = 0;
    const rowSet = new Set((row.tokens || '').split(' '));
    for (const w of words) { if (rowSet.has(w)) score++; }
    row.relevance = score / words.length;
  }

  rows.sort((a, b) => b.relevance - a.relevance);
  return rows;
}

// ── Skills ───────────────────────────────────────────────

function addSkill(skill) {
  const tokens = tokenize(
    (skill.name || '') + ' ' + (skill.description || '') + ' ' + (skill.app_context || '')
  );
  const steps = typeof skill.steps === 'string' ? skill.steps : JSON.stringify(skill.steps);
  return getDb().prepare(`
    INSERT INTO skills (name, description, steps, preconditions, app_context, confidence, source_session_id, created_at, tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    skill.name,
    skill.description,
    steps,
    skill.preconditions || null,
    skill.app_context || null,
    skill.confidence || 0.3,
    skill.source_session_id || null,
    utcNow(),
    tokens
  ).lastInsertRowid;
}

function getSkill(skillId) {
  const row = getDb().prepare('SELECT * FROM skills WHERE id = ?').get(skillId);
  if (!row) return null;
  if (row.steps) {
    try { row.steps = JSON.parse(row.steps); } catch (_) { /* keep as string */ }
  }
  return row;
}

function reinforceSkill(skillId) {
  getDb().prepare(`
    UPDATE skills SET confidence = MIN(1.0, confidence + 0.1), last_used_at = ? WHERE id = ?
  `).run(utcNow(), skillId);
}

function weakenSkill(skillId) {
  getDb().prepare(`
    UPDATE skills SET confidence = MAX(0.0, confidence - 0.15), last_used_at = ? WHERE id = ?
  `).run(utcNow(), skillId);
}

function findSkillByName(name) {
  return getDb().prepare(
    'SELECT * FROM skills WHERE name = ? LIMIT 1'
  ).get(name) || null;
}

function searchSkills(query, opts = {}) {
  const words = tokenizeToArray(query);
  if (!words.length) return [];

  const conditions = words.map(() => 'instr(tokens, ?) > 0');
  const params = words.slice();

  let sql = `SELECT * FROM skills WHERE (${conditions.join(' OR ')})`;
  if (opts.app) { sql += ' AND app_context = ?'; params.push(opts.app); }
  if (opts.minConfidence) { sql += ' AND confidence >= ?'; params.push(opts.minConfidence); }
  sql += ' ORDER BY confidence DESC LIMIT ?';
  params.push(opts.limit || 10);

  const rows = getDb().prepare(sql).all(...params);

  for (const row of rows) {
    let score = 0;
    const rowSet = new Set((row.tokens || '').split(' '));
    for (const w of words) { if (rowSet.has(w)) score++; }
    row.relevance = score / words.length;
    if (row.steps) {
      try { row.steps = JSON.parse(row.steps); } catch (_) {}
    }
  }

  return rows;
}

function getTopSkills(limit) {
  const rows = getDb().prepare(
    'SELECT * FROM skills WHERE confidence >= 0.3 ORDER BY confidence DESC LIMIT ?'
  ).all(limit || 20);
  for (const row of rows) {
    if (row.steps) { try { row.steps = JSON.parse(row.steps); } catch (_) {} }
  }
  return rows;
}

function getSkillsByApp(app, limit) {
  const rows = getDb().prepare(
    'SELECT * FROM skills WHERE app_context = ? ORDER BY confidence DESC LIMIT ?'
  ).all(app, limit || 10);
  for (const row of rows) {
    if (row.steps) { try { row.steps = JSON.parse(row.steps); } catch (_) {} }
  }
  return rows;
}

function decaySkills(hoursOld) {
  hoursOld = hoursOld || 168;
  const cutoff = new Date(Date.now() - hoursOld * 60 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
  getDb().prepare(`
    UPDATE skills SET confidence = MAX(0.05, confidence - 0.05)
    WHERE confidence > 0.05
    AND last_used_at IS NOT NULL
    AND last_used_at < ?
  `).run(cutoff);
}

// ── Reflections ──────────────────────────────────────────

function addReflection(reflection) {
  const tokens = tokenize(
    (reflection.what_happened || '') + ' ' +
    (reflection.what_worked || '') + ' ' +
    (reflection.what_failed || '') + ' ' +
    (reflection.strategy || '')
  );
  return getDb().prepare(`
    INSERT INTO reflections (session_id, outcome, what_happened, what_worked, what_failed, strategy, anti_pattern, confidence, created_at, tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reflection.session_id,
    reflection.outcome,
    reflection.what_happened,
    reflection.what_worked || null,
    reflection.what_failed || null,
    reflection.strategy || null,
    reflection.anti_pattern || null,
    reflection.confidence || 0.3,
    utcNow(),
    tokens
  ).lastInsertRowid;
}

function getReflection(reflectionId) {
  return getDb().prepare('SELECT * FROM reflections WHERE id = ?').get(reflectionId) || null;
}

function getSessionReflection(sessionId) {
  return getDb().prepare(
    'SELECT * FROM reflections WHERE session_id = ? ORDER BY id DESC LIMIT 1'
  ).get(sessionId) || null;
}

function confirmReflection(reflectionId) {
  getDb().prepare(
    'UPDATE reflections SET confirmed = 1, confidence = MIN(1.0, confidence + 0.2) WHERE id = ?'
  ).run(reflectionId);
}

function searchReflections(query, opts = {}) {
  const words = tokenizeToArray(query);
  if (!words.length) return [];

  const conditions = words.map(() => 'instr(tokens, ?) > 0');
  const params = words.slice();

  let sql = `SELECT * FROM reflections WHERE (${conditions.join(' OR ')})`;
  if (opts.outcome) { sql += ' AND outcome = ?'; params.push(opts.outcome); }
  if (opts.confirmedOnly) { sql += ' AND confirmed = 1'; }
  sql += ' ORDER BY confidence DESC, created_at DESC LIMIT ?';
  params.push(opts.limit || 10);

  const rows = getDb().prepare(sql).all(...params);

  for (const row of rows) {
    let score = 0;
    const rowSet = new Set((row.tokens || '').split(' '));
    for (const w of words) { if (rowSet.has(w)) score++; }
    row.relevance = score / words.length;
  }

  rows.sort((a, b) => b.relevance - a.relevance);
  return rows;
}

function getAntiPatterns(limit) {
  return getDb().prepare(
    `SELECT * FROM reflections WHERE anti_pattern IS NOT NULL AND anti_pattern != ''
     ORDER BY confidence DESC LIMIT ?`
  ).all(limit || 10);
}

// ── Stats ────────────────────────────────────────────────

function stats() {
  const d = getDb();
  return {
    sessions:    d.prepare('SELECT COUNT(*) as c FROM sessions').get().c,
    memories:    d.prepare('SELECT COUNT(*) as c FROM memories').get().c,
    skills:      d.prepare('SELECT COUNT(*) as c FROM skills').get().c,
    reflections: d.prepare('SELECT COUNT(*) as c FROM reflections').get().c,
    confirmedReflections: d.prepare('SELECT COUNT(*) as c FROM reflections WHERE confirmed = 1').get().c,
    avgConfidence: d.prepare('SELECT AVG(confidence) as a FROM skills').get().a || 0,
    successRate: (() => {
      const total = d.prepare(
        `SELECT COUNT(*) as c FROM sessions WHERE outcome IN ('success', 'failure', 'stopped')`
      ).get().c;
      if (!total) return null;
      const wins = d.prepare('SELECT COUNT(*) as c FROM sessions WHERE outcome = ?').get('success').c;
      return Math.round((wins / total) * 100);
    })(),
    topApps: d.prepare(
      `SELECT app_context, COUNT(*) as count, AVG(confidence) as avg_conf
       FROM skills WHERE app_context IS NOT NULL
       GROUP BY app_context ORDER BY count DESC LIMIT 5`
    ).all()
  };
}

// ── Utilities ────────────────────────────────────────────

function tokenize(text) {
  if (!text) return '';
  return tokenizeToArray(text).join(' ');
}

function tokenizeToArray(text) {
  if (!text) return [];
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
  const seen = new Set();
  const result = [];
  for (const w of words) {
    if (!seen.has(w)) { seen.add(w); result.push(w); }
  }
  return result;
}

module.exports = {
  init, close, getDb,
  createSession, endSession, getSession, getRecentSessions,
  addMemory, getMemories, getMemoriesByType, searchMemories,
  addSkill, getSkill, reinforceSkill, weakenSkill, findSkillByName,
  searchSkills, getTopSkills, getSkillsByApp, decaySkills,
  addReflection, getReflection, getSessionReflection, confirmReflection,
  searchReflections, getAntiPatterns,
  stats, tokenize, tokenizeToArray,
  VALID_TYPES, VALID_OUTCOMES
};
