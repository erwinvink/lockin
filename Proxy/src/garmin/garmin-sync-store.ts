import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type GarminSyncOperationStatus =
  | "pending"
  | "blocked_on_delete"
  | "retrying"
  | "synced"
  | "failed"
  | "deleted";

export type GarminSyncWorkoutPayload = {
  sessionId: string;
  title: string;
  date: string;
  kind: string;
  distanceKm: number;
  durationMinutes: number;
  target: {
    type: string;
    low: number;
    high: number;
  };
  notes: string;
  existingGarminWorkoutId?: string | null;
};

export type GarminWorkoutSyncRecord = {
  sessionId: string;
  contentHash: string;
  payload: GarminSyncWorkoutPayload;
  status: GarminSyncOperationStatus;
  garminWorkoutId: string | null;
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  pushedAt: string | null;
  updatedAt: string;
};

export type GarminDeleteSyncRecord = {
  workoutId: string;
  status: GarminSyncOperationStatus;
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GarminUserSyncState = {
  userId: string;
  provider: "sidecar";
  planRevisionId: string | null;
  status: "idle" | "syncing" | "synced" | "retrying" | "failed" | "blocked_on_delete";
  lastError: string | null;
  updatedAt: string;
  workouts: Record<string, GarminWorkoutSyncRecord>;
  deletes: Record<string, GarminDeleteSyncRecord>;
};

export type GarminSyncStateFile = {
  version: 1;
  users: Record<string, GarminUserSyncState>;
};

export class GarminSyncStore {
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = defaultSyncStatePath()) {}

  async read(): Promise<GarminSyncStateFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<GarminSyncStateFile>;
      if (parsed.version !== 1 || typeof parsed.users !== "object" || parsed.users === null) {
        return emptyState();
      }
      return { version: 1, users: parsed.users as Record<string, GarminUserSyncState> };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyState();
      }
      throw error;
    }
  }

  async write(state: GarminSyncStateFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }

  async updateUser(
    userId: string,
    mutate: (user: GarminUserSyncState, state: GarminSyncStateFile) => void | Promise<void>
  ): Promise<GarminUserSyncState> {
    const previousUpdate = this.updateQueue;
    let releaseUpdate: () => void = () => {};
    this.updateQueue = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    await previousUpdate;

    try {
      const state = await this.read();
      const now = new Date().toISOString();
      const user = state.users[userId] ?? {
        userId,
        provider: "sidecar",
        planRevisionId: null,
        status: "idle",
        lastError: null,
        updatedAt: now,
        workouts: {},
        deletes: {}
      };

      state.users[userId] = user;
      await mutate(user, state);
      user.updatedAt = new Date().toISOString();
      await this.write(state);
      return user;
    } finally {
      releaseUpdate();
    }
  }
}

export function emptyState(): GarminSyncStateFile {
  return { version: 1, users: {} };
}

function defaultSyncStatePath(): string {
  return process.env.GARMIN_SYNC_STATE_PATH ?? join(process.cwd(), ".data", "garmin-sync-state.json");
}
