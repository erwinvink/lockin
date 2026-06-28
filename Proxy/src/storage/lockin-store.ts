import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashPassword, verifyPassword, type PublicUser } from "./lockin-auth";

export const currentOwnerDisplayName = "Erwin vink";
export const currentOwnerUsername = "erwin.vink";

const modelNames = [
  "profiles",
  "race_goals",
  "sessions",
  "workout_blocks",
  "set_prescriptions",
  "strength_logs",
  "run_logs",
  "garmin_snapshots",
  "coach_plans",
  "coach_verdicts",
  "garmin_connections",
  "sync_cursors",
  "jobs"
] as const;

export type LockinModelName = (typeof modelNames)[number];

export type LockinRecordPayload = Record<string, unknown> & { id?: unknown };

export type LocalStoreImport = {
  ownerDisplayName?: string;
  profile?: LockinRecordPayload;
  profiles?: LockinRecordPayload[];
  raceGoals?: LockinRecordPayload[];
  sessions?: LockinRecordPayload[];
  workoutBlocks?: LockinRecordPayload[];
  setPrescriptions?: LockinRecordPayload[];
  strengthLogs?: LockinRecordPayload[];
  runLogs?: LockinRecordPayload[];
  garminSnapshots?: LockinRecordPayload[];
  coachPlans?: LockinRecordPayload[];
  coachVerdicts?: LockinRecordPayload[];
};

export type SyncMutation = {
  clientMutationId?: unknown;
  model?: unknown;
  op?: unknown;
  id?: unknown;
  data?: unknown;
};

export type StoredRecord = {
  id: string;
  userId: string;
  payload: LockinRecordPayload;
  revision: number;
  serverSeq: number;
  updatedAt: string;
  deletedAt: string | null;
};

export type BootstrapPayload = {
  user: PublicUser;
  serverSeq: number;
  profile: LockinRecordPayload | null;
  profiles: LockinRecordPayload[];
  raceGoals: LockinRecordPayload[];
  sessions: LockinRecordPayload[];
  workoutBlocks: LockinRecordPayload[];
  setPrescriptions: LockinRecordPayload[];
  strengthLogs: LockinRecordPayload[];
  runLogs: LockinRecordPayload[];
  garminSnapshots: LockinRecordPayload[];
  coachPlans: LockinRecordPayload[];
  coachVerdicts: LockinRecordPayload[];
};

type ChangeRow = {
  seq: number;
  user_id: string;
  model: LockinModelName;
  record_id: string;
  operation: "upsert" | "delete";
  payload_json: string | null;
  changed_at: string;
};

const apiCollections = {
  profiles: "profiles",
  raceGoals: "race_goals",
  sessions: "sessions",
  workoutBlocks: "workout_blocks",
  setPrescriptions: "set_prescriptions",
  strengthLogs: "strength_logs",
  runLogs: "run_logs",
  garminSnapshots: "garmin_snapshots",
  coachPlans: "coach_plans",
  coachVerdicts: "coach_verdicts"
} as const satisfies Record<string, LockinModelName>;

export class LockinStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = defaultDataPath()) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  registerUser(input: { username: string; password: string; displayName?: string }): PublicUser {
    const username = normalizeUsername(input.username);
    const password = cleanString(input.password);
    if (!username || password.length < 8) {
      throw new LockinInputError("username and an 8+ character password are required");
    }
    const now = new Date().toISOString();
    const displayName = cleanString(input.displayName) || defaultDisplayNameFor(username);
    const passwordParts = hashPassword(password);
    const id = randomUUID();

    try {
      this.db.prepare(`
        INSERT INTO users (id, username, display_name, password_hash, password_salt, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, username, displayName, passwordParts.hash, passwordParts.salt, now, now);
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new LockinInputError("username is already registered");
      }
      throw error;
    }

    return { id, username, displayName };
  }

  authenticateUser(input: { username: string; password: string }): PublicUser {
    const username = normalizeUsername(input.username);
    const row = this.db.prepare(`
      SELECT id, username, display_name, password_hash, password_salt
      FROM users
      WHERE username = ? AND deleted_at IS NULL
    `).get(username) as {
      id: string;
      username: string;
      display_name: string;
      password_hash: string;
      password_salt: string;
    } | undefined;

    if (!row || !verifyPassword(cleanString(input.password), row.password_salt, row.password_hash)) {
      throw new LockinAuthError("invalid username or password");
    }

    return { id: row.id, username: row.username, displayName: row.display_name };
  }

  userById(userId: string): PublicUser | null {
    const row = this.db.prepare(`
      SELECT id, username, display_name
      FROM users
      WHERE id = ? AND deleted_at IS NULL
    `).get(userId) as { id: string; username: string; display_name: string } | undefined;
    return row ? { id: row.id, username: row.username, displayName: row.display_name } : null;
  }

  importLocalStore(userId: string, input: LocalStoreImport): BootstrapPayload {
    const user = this.requireUser(userId);
    const ownerDisplayName = cleanString(input.ownerDisplayName) || user.displayName;
    this.transaction(() => {
      const profiles = input.profiles ?? (input.profile ? [input.profile] : []);
      if (profiles.length === 0) {
        this.upsertRecord(userId, "profiles", { id: randomUUID(), name: ownerDisplayName });
      } else {
        for (const profile of profiles) {
          this.upsertRecord(userId, "profiles", normalizeProfilePayload(profile, ownerDisplayName));
        }
      }
      this.importCollection(userId, "race_goals", input.raceGoals);
      this.importCollection(userId, "sessions", input.sessions);
      this.importCollection(userId, "workout_blocks", input.workoutBlocks);
      this.importCollection(userId, "set_prescriptions", input.setPrescriptions);
      this.importCollection(userId, "strength_logs", input.strengthLogs);
      this.importCollection(userId, "run_logs", input.runLogs);
      this.importCollection(userId, "garmin_snapshots", input.garminSnapshots);
      this.importCollection(userId, "coach_plans", input.coachPlans);
      this.importCollection(userId, "coach_verdicts", input.coachVerdicts);
    });
    return this.bootstrap(userId);
  }

  bootstrap(userId: string): BootstrapPayload {
    const user = this.requireUser(userId);
    const profiles = this.records(userId, "profiles").map((record) => record.payload);
    return {
      user,
      serverSeq: this.latestSeq(userId),
      profile: profiles[0] ?? null,
      profiles,
      raceGoals: this.records(userId, "race_goals").map((record) => record.payload),
      sessions: this.records(userId, "sessions").map((record) => record.payload),
      workoutBlocks: this.records(userId, "workout_blocks").map((record) => record.payload),
      setPrescriptions: this.records(userId, "set_prescriptions").map((record) => record.payload),
      strengthLogs: this.records(userId, "strength_logs").map((record) => record.payload),
      runLogs: this.records(userId, "run_logs").map((record) => record.payload),
      garminSnapshots: this.records(userId, "garmin_snapshots").map((record) => record.payload),
      coachPlans: this.records(userId, "coach_plans").map((record) => record.payload),
      coachVerdicts: this.records(userId, "coach_verdicts").map((record) => record.payload)
    };
  }

  updateProfile(userId: string, input: unknown): LockinRecordPayload {
    const user = this.requireUser(userId);
    if (!isRecord(input)) {
      throw new LockinInputError("profile object is required");
    }
    const existing = this.records(userId, "profiles")[0]?.payload;
    const payload = normalizeProfilePayload(
      { ...(existing ?? {}), ...input },
      user.displayName
    );
    return this.upsertRecord(userId, "profiles", payload).payload;
  }

  pushMutations(userId: string, mutationsInput: unknown): {
    serverSeq: number;
    applied: Array<{ clientMutationId: string; model: LockinModelName; id: string; operation: string; serverSeq: number }>;
  } {
    this.requireUser(userId);
    if (!Array.isArray(mutationsInput)) {
      throw new LockinInputError("mutations array is required");
    }

    const applied: Array<{ clientMutationId: string; model: LockinModelName; id: string; operation: string; serverSeq: number }> = [];
    this.transaction(() => {
      for (const mutation of mutationsInput as SyncMutation[]) {
        const clientMutationId = cleanString(mutation.clientMutationId);
        const model = normalizeModelName(mutation.model);
        const operation = cleanString(mutation.op) || "upsert";
        const id = cleanString(mutation.id) || (isRecord(mutation.data) ? cleanString(mutation.data.id) : "");
        if (!clientMutationId || !model || !id) {
          throw new LockinInputError("each mutation needs clientMutationId, model, and id");
        }

        const existing = this.db.prepare(`
          SELECT result_json FROM client_mutations WHERE user_id = ? AND client_mutation_id = ?
        `).get(userId, clientMutationId) as { result_json: string } | undefined;
        if (existing) {
          applied.push(JSON.parse(existing.result_json) as (typeof applied)[number]);
          continue;
        }

        let result: (typeof applied)[number];
        if (operation === "delete") {
          const seq = this.deleteRecord(userId, model, id).serverSeq;
          result = { clientMutationId, model, id, operation, serverSeq: seq };
        } else if (operation === "upsert") {
          if (!isRecord(mutation.data)) {
            throw new LockinInputError("upsert mutations need data");
          }
          const record = this.upsertRecord(userId, model, { ...mutation.data, id });
          result = { clientMutationId, model, id: record.id, operation: "upsert", serverSeq: record.serverSeq };
        } else {
          throw new LockinInputError(`unsupported mutation op: ${operation}`);
        }

        this.db.prepare(`
          INSERT INTO client_mutations (user_id, client_mutation_id, result_json, created_at)
          VALUES (?, ?, ?, ?)
        `).run(userId, clientMutationId, JSON.stringify(result), new Date().toISOString());
        applied.push(result);
      }
    });

    return { serverSeq: this.latestSeq(userId), applied };
  }

  pullChanges(userId: string, since: number): {
    serverSeq: number;
    changes: Array<{ seq: number; model: LockinModelName; id: string; operation: string; data: LockinRecordPayload | null; changedAt: string }>;
  } {
    this.requireUser(userId);
    const rows = this.db.prepare(`
      SELECT seq, user_id, model, record_id, operation, payload_json, changed_at
      FROM record_changes
      WHERE user_id = ? AND seq > ?
      ORDER BY seq ASC
    `).all(userId, Math.max(0, Math.floor(since))) as ChangeRow[];

    return {
      serverSeq: this.latestSeq(userId),
      changes: rows.map((row) => ({
        seq: row.seq,
        model: row.model,
        id: row.record_id,
        operation: row.operation,
        data: row.payload_json ? JSON.parse(row.payload_json) as LockinRecordPayload : null,
        changedAt: row.changed_at
      }))
    };
  }

  currentWeek(userId: string, weekStartInput?: string): {
    weekStart: string;
    weekEnd: string;
    sessions: LockinRecordPayload[];
    setPrescriptions: LockinRecordPayload[];
  } {
    this.requireUser(userId);
    const weekStart = startOfDay(weekStartInput ? new Date(weekStartInput) : new Date());
    const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
    const sessions = this.records(userId, "sessions")
      .map((record) => record.payload)
      .filter((session) => {
        const value = dateValue(session.scheduledDate ?? session.date);
        return value !== null && value >= weekStart.getTime() && value < weekEnd.getTime();
      })
      .sort((a, b) => (dateValue(a.scheduledDate ?? a.date) ?? 0) - (dateValue(b.scheduledDate ?? b.date) ?? 0));

    const sessionIds = new Set(sessions.map((session) => cleanString(session.id)));
    const setPrescriptions = this.records(userId, "set_prescriptions")
      .map((record) => record.payload)
      .filter((item) => sessionIds.has(cleanString(item.sessionId)));

    return {
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      sessions,
      setPrescriptions
    };
  }

  planStatus(userId: string): {
    latestPlan: LockinRecordPayload | null;
    latestVerdict: LockinRecordPayload | null;
    serverSeq: number;
  } {
    this.requireUser(userId);
    return {
      latestPlan: latestByDate(this.records(userId, "coach_plans").map((record) => record.payload), ["generatedAt", "createdAt", "weekStart"]),
      latestVerdict: latestByDate(this.records(userId, "coach_verdicts").map((record) => record.payload), ["createdAt"]),
      serverSeq: this.latestSeq(userId)
    };
  }

  syncStatus(userId: string): {
    user: PublicUser;
    serverSeq: number;
    counts: Record<string, number>;
  } {
    const user = this.requireUser(userId);
    const counts: Record<string, number> = {};
    for (const model of modelNames) {
      counts[model] = this.countRecords(userId, model);
    }
    return { user, serverSeq: this.latestSeq(userId), counts };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS record_changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        model TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_json TEXT,
        changed_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS client_mutations (
        user_id TEXT NOT NULL,
        client_mutation_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, client_mutation_id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);

    for (const model of modelNames) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${model} (
          user_id TEXT NOT NULL,
          id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT,
          revision INTEGER NOT NULL,
          server_seq INTEGER NOT NULL,
          PRIMARY KEY (user_id, id),
          FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_${model}_user_updated ON ${model}(user_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_${model}_user_seq ON ${model}(user_id, server_seq);
      `);
    }
  }

  private importCollection(userId: string, model: LockinModelName, collection: unknown[] | undefined): void {
    for (const item of collection ?? []) {
      if (isRecord(item)) {
        this.upsertRecord(userId, model, item);
      }
    }
  }

  private upsertRecord(userId: string, model: LockinModelName, payloadInput: LockinRecordPayload): StoredRecord {
    const id = cleanString(payloadInput.id) || randomUUID();
    const payload = { ...payloadInput, id };
    const now = new Date().toISOString();
    const table = tableFor(model);
    const existing = this.db.prepare(`
      SELECT revision, created_at FROM ${table} WHERE user_id = ? AND id = ?
    `).get(userId, id) as { revision: number; created_at: string } | undefined;
    const revision = (existing?.revision ?? 0) + 1;
    const createdAt = existing?.created_at ?? now;
    const payloadJSON = JSON.stringify(payload);

    this.db.prepare(`
      INSERT INTO ${table} (user_id, id, payload_json, created_at, updated_at, deleted_at, revision, server_seq)
      VALUES (?, ?, ?, ?, ?, NULL, ?, 0)
      ON CONFLICT(user_id, id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at,
        deleted_at = NULL,
        revision = excluded.revision
    `).run(userId, id, payloadJSON, createdAt, now, revision);

    const serverSeq = this.recordChange(userId, model, id, "upsert", payloadJSON, now);
    this.db.prepare(`UPDATE ${table} SET server_seq = ? WHERE user_id = ? AND id = ?`).run(serverSeq, userId, id);
    return { id, userId, payload, revision, serverSeq, updatedAt: now, deletedAt: null };
  }

  private deleteRecord(userId: string, model: LockinModelName, id: string): { serverSeq: number } {
    const now = new Date().toISOString();
    const table = tableFor(model);
    this.db.prepare(`
      UPDATE ${table}
      SET deleted_at = ?, updated_at = ?, revision = revision + 1
      WHERE user_id = ? AND id = ?
    `).run(now, now, userId, id);
    return { serverSeq: this.recordChange(userId, model, id, "delete", null, now) };
  }

  private records(userId: string, model: LockinModelName): StoredRecord[] {
    const rows = this.db.prepare(`
      SELECT user_id, id, payload_json, revision, server_seq, updated_at, deleted_at
      FROM ${tableFor(model)}
      WHERE user_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC, id ASC
    `).all(userId) as Array<{
      user_id: string;
      id: string;
      payload_json: string;
      revision: number;
      server_seq: number;
      updated_at: string;
      deleted_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      payload: JSON.parse(row.payload_json) as LockinRecordPayload,
      revision: row.revision,
      serverSeq: row.server_seq,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at
    }));
  }

  private countRecords(userId: string, model: LockinModelName): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM ${tableFor(model)} WHERE user_id = ? AND deleted_at IS NULL
    `).get(userId) as { count: number };
    return row.count;
  }

  private recordChange(
    userId: string,
    model: LockinModelName,
    recordId: string,
    operation: "upsert" | "delete",
    payloadJSON: string | null,
    changedAt: string
  ): number {
    const result = this.db.prepare(`
      INSERT INTO record_changes (user_id, model, record_id, operation, payload_json, changed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, model, recordId, operation, payloadJSON, changedAt);
    return Number(result.lastInsertRowid);
  }

  private latestSeq(userId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS seq FROM record_changes WHERE user_id = ?
    `).get(userId) as { seq: number };
    return row.seq;
  }

  private requireUser(userId: string): PublicUser {
    const user = this.userById(userId);
    if (!user) {
      throw new LockinAuthError("user not found");
    }
    return user;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function isLockinModelName(value: string): value is LockinModelName {
  return (modelNames as readonly string[]).includes(value);
}

export function normalizeModelName(value: unknown): LockinModelName | null {
  const raw = cleanString(value);
  if (isLockinModelName(raw)) {
    return raw;
  }

  const mapped = (apiCollections as Record<string, LockinModelName>)[raw];
  return mapped ?? null;
}

export function normalizeProfilePayload(payloadInput: LockinRecordPayload, ownerDisplayName = currentOwnerDisplayName): LockinRecordPayload {
  const payload = { ...payloadInput };
  const rawName = cleanString(payload.name);
  const normalizedDefault = rawName.toLowerCase();
  if (!rawName || normalizedDefault === "athlete" || normalizedDefault === "erwin") {
    payload.name = ownerDisplayName;
  }
  return payload;
}

function tableFor(model: LockinModelName): LockinModelName {
  if (!isLockinModelName(model)) {
    throw new LockinInputError(`unsupported model: ${model}`);
  }
  return model;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUsername(value: unknown): string {
  return cleanString(value).toLowerCase();
}

function defaultDisplayNameFor(username: string): string {
  return username === currentOwnerUsername ? currentOwnerDisplayName : username;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dateValue(value: unknown): number | null {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function startOfDay(date: Date): Date {
  const result = new Date(date);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

function latestByDate(records: LockinRecordPayload[], keys: string[]): LockinRecordPayload | null {
  return [...records].sort((a, b) => {
    const lhs = Math.max(...keys.map((key) => dateValue(a[key]) ?? 0));
    const rhs = Math.max(...keys.map((key) => dateValue(b[key]) ?? 0));
    return rhs - lhs;
  })[0] ?? null;
}

function defaultDataPath(): string {
  return process.env.LOCKIN_DB_PATH ?? join(process.cwd(), ".data", "lockin.sqlite");
}

export class LockinInputError extends Error {}
export class LockinAuthError extends Error {}
