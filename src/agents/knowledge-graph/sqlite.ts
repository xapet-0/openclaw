import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../../config/paths.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { resolveUserPath } from "../../utils.js";

export type KnowledgeGraphTurn = {
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  prompt: string;
  response: string;
  metadata?: Record<string, unknown>;
};

export type KnowledgeGraphConfig = {
  enabled: boolean;
  dbPath: string;
};

export const KNOWLEDGE_GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS kg_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  session_key TEXT,
  provider TEXT,
  model TEXT,
  prompt TEXT NOT NULL,
  response TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kg_documents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT,
  url TEXT,
  content TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kg_nodes (
  id TEXT PRIMARY KEY,
  node_type TEXT NOT NULL,
  label TEXT NOT NULL,
  data_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kg_edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  data_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS kg_turns_session_idx ON kg_turns(session_id, created_at);
CREATE INDEX IF NOT EXISTS kg_documents_kind_idx ON kg_documents(kind, created_at);
CREATE INDEX IF NOT EXISTS kg_edges_source_idx ON kg_edges(source_id);
CREATE INDEX IF NOT EXISTS kg_edges_target_idx ON kg_edges(target_id);
`;

const DEFAULT_DB_FILE = "graph.sqlite";

export function resolveKnowledgeGraphConfig(): KnowledgeGraphConfig {
  const enabled =
    isTruthyEnvValue(process.env.OPENCLAW_KG_ENABLED) ||
    isTruthyEnvValue(process.env.OPENCLAW_KG_DB_ENABLED) ||
    Boolean(process.env.OPENCLAW_KG_DB?.trim());
  const stateDir = resolveStateDir(process.env, os.homedir);
  const fallback = path.join(stateDir, "knowledge-graph", DEFAULT_DB_FILE);
  const dbPath = resolveUserPath(process.env.OPENCLAW_KG_DB?.trim() || fallback);
  return { enabled, dbPath };
}

function ensureDbDir(dbPath: string): void {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
}

let cachedDb: { path: string; db: DatabaseSync } | null = null;

function getDatabase(dbPath: string): DatabaseSync {
  if (cachedDb && cachedDb.path === dbPath) {
    return cachedDb.db;
  }
  ensureDbDir(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(KNOWLEDGE_GRAPH_SCHEMA);
  cachedDb = { path: dbPath, db };
  return db;
}

export async function persistKnowledgeGraphTurn(
  config: KnowledgeGraphConfig,
  turn: KnowledgeGraphTurn,
): Promise<void> {
  if (!config.enabled) {
    return;
  }
  const db = getDatabase(config.dbPath);
  const now = Date.now();
  const id = crypto.randomUUID();
  const stmt = db.prepare(
    `INSERT INTO kg_turns (id, session_id, session_key, provider, model, prompt, response, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    id,
    turn.sessionId ?? null,
    turn.sessionKey ?? null,
    turn.provider ?? null,
    turn.model ?? null,
    turn.prompt,
    turn.response,
    turn.metadata ? JSON.stringify(turn.metadata) : null,
    now,
  );
}
