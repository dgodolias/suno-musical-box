import type { BiometricReading } from "./biometrics";

export interface RecordingSession {
  clientSessionId: string;
  serverSessionId: number | null;
  startedAt: number;
  endedAt: number | null;
  endAcknowledged: boolean;
  notes: string;
  genre1: string | null;
  genre2: string | null;
  generationAttempted: boolean;
  retired: boolean;
  person1Count: number;
  person2Count: number;
  acknowledgedCount: number;
}

export interface RecordedReading extends BiometricReading {
  sampleId: string;
}

export interface StoredReading extends RecordedReading {
  clientSessionId: string;
  uploaded: 0 | 1;
}

export interface RecordingStorage {
  open(): Promise<void>;
  listSessions(): Promise<RecordingSession[]>;
  getSession(id: string): Promise<RecordingSession | undefined>;
  createSession(session: RecordingSession): Promise<void>;
  updateSession(id: string, patch: Partial<RecordingSession>): Promise<void>;
  addReading(reading: StoredReading): Promise<void>;
  readings(id: string, pendingOnly: boolean, limit?: number): Promise<StoredReading[]>;
  acknowledge(id: string, sampleIds: string[]): Promise<void>;
  prune(id: string): Promise<void>;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Local recording storage failed"));
  });
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Local recording transaction failed"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Local recording transaction failed"));
  });
}

/** Browser-only durable storage. Never stores secrets or synthesizes measurements. */
export class IndexedDbRecordingStorage implements RecordingStorage {
  private database: IDBDatabase | null = null;
  private opening: Promise<void> | null = null;

  open(): Promise<void> {
    if (this.database) return Promise.resolve();
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      const request = indexedDB.open("musical-box-recordings", 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore("sessions", { keyPath: "clientSessionId" });
        const samples = database.createObjectStore("samples", { keyPath: "sampleId" });
        samples.createIndex("session", "clientSessionId");
        samples.createIndex("pending", ["clientSessionId", "uploaded"]);
      };
      request.onsuccess = () => {
        this.database = request.result;
        this.database.onversionchange = () => { this.database?.close(); this.database = null; this.opening = null; };
        resolve();
      };
      request.onerror = () => { this.opening = null; reject(request.error ?? new Error("Could not open local recording storage")); };
      request.onblocked = () => { this.opening = null; reject(new Error("Close older Musical Box tabs to enable recording storage")); };
    });
    return this.opening;
  }

  private transaction(stores: string | string[], mode: IDBTransactionMode = "readonly") {
    if (!this.database) throw new Error("Recording storage is not ready");
    return this.database.transaction(stores, mode);
  }

  async listSessions() {
    return result<RecordingSession[]>(this.transaction("sessions").objectStore("sessions").getAll());
  }

  async getSession(id: string) {
    return result<RecordingSession | undefined>(this.transaction("sessions").objectStore("sessions").get(id));
  }

  async createSession(session: RecordingSession) {
    const transaction = this.transaction("sessions", "readwrite");
    const finished = complete(transaction);
    transaction.objectStore("sessions").add(session);
    await finished;
  }

  async updateSession(id: string, patch: Partial<RecordingSession>) {
    const transaction = this.transaction("sessions", "readwrite");
    const finished = complete(transaction);
    const store = transaction.objectStore("sessions");
    const request = store.get(id);
    request.onsuccess = () => {
      if (!request.result) { transaction.abort(); return; }
      store.put({ ...request.result, ...patch, clientSessionId: id });
    };
    await finished;
  }

  async addReading(reading: StoredReading) {
    const transaction = this.transaction(["sessions", "samples"], "readwrite");
    const finished = complete(transaction);
    const samples = transaction.objectStore("samples");
    const sessions = transaction.objectStore("sessions");
    const existing = samples.get(reading.sampleId);
    existing.onsuccess = () => {
      if (existing.result) {
        // An ID may be retried, but must never identify a different observation.
        const prior: StoredReading = existing.result;
        if (Object.keys(reading).some((key) => key !== "uploaded" &&
          prior[key as keyof StoredReading] !== reading[key as keyof StoredReading])) transaction.abort();
        return;
      }
      const parent = sessions.get(reading.clientSessionId);
      parent.onsuccess = () => {
        const session: RecordingSession | undefined = parent.result;
        if (!session || reading.timestamp < session.startedAt || (session.endedAt !== null && reading.timestamp > session.endedAt)) {
          transaction.abort();
          return;
        }
        samples.add(reading);
        const count = reading.personId === 1 ? "person1Count" : "person2Count";
        sessions.put({ ...session, [count]: session[count] + 1 });
      };
    };
    await finished;
  }

  async readings(id: string, pendingOnly: boolean, limit?: number) {
    const store = this.transaction("samples").objectStore("samples");
    const index = store.index(pendingOnly ? "pending" : "session");
    return result<StoredReading[]>(index.getAll(pendingOnly ? [id, 0] : id, limit));
  }

  async acknowledge(id: string, sampleIds: string[]) {
    const transaction = this.transaction(["sessions", "samples"], "readwrite");
    const finished = complete(transaction);
    const samples = transaction.objectStore("samples");
    const sessions = transaction.objectStore("sessions");
    const uniqueIds = [...new Set(sampleIds)];
    let remaining = uniqueIds.length;
    let newlyAcknowledged = 0;
    // Update the parent once after all sample reads; multiple parent reads in
    // the same transaction could otherwise overwrite each other's increments.
    for (const sampleId of uniqueIds) {
      const request = samples.get(sampleId);
      request.onsuccess = () => {
        const sample: StoredReading | undefined = request.result;
        if (sample && sample.clientSessionId === id && sample.uploaded === 0) {
          samples.put({ ...sample, uploaded: 1 });
          newlyAcknowledged++;
        }
        if (--remaining === 0 && newlyAcknowledged > 0) {
          const parent = sessions.get(id);
          parent.onsuccess = () => {
            const session: RecordingSession | undefined = parent.result;
            if (session) sessions.put({ ...session, acknowledgedCount: session.acknowledgedCount + newlyAcknowledged });
          };
        }
      };
    }
    await finished;
  }

  async prune(id: string) {
    const transaction = this.transaction(["sessions", "samples"], "readwrite");
    const finished = complete(transaction);
    const sessions = transaction.objectStore("sessions");
    const samples = transaction.objectStore("samples");
    const request = sessions.get(id);
    request.onsuccess = () => {
      const session: RecordingSession | undefined = request.result;
      if (!session?.retired || !session.endAcknowledged || session.acknowledgedCount !== session.person1Count + session.person2Count) return;
      const cursor = samples.index("session").openKeyCursor(id);
      cursor.onsuccess = () => {
        if (cursor.result) { samples.delete(cursor.result.primaryKey); cursor.result.continue(); }
      };
      sessions.delete(id);
    };
    await finished;
  }
}

export interface RecordingSyncStatus {
  ready: boolean;
  uploading: boolean;
  pendingReadings: number;
  pendingSessions: number;
  localWrites: number;
  storageError: string | null;
  networkError: string | null;
  sessions: RecordingSession[];
}

export const EMPTY_SYNC_STATUS: RecordingSyncStatus = {
  ready: false, uploading: false, pendingReadings: 0, pendingSessions: 0,
  localWrites: 0, storageError: null, networkError: null, sessions: [],
};

const BATCH_SIZE = 250;
const RETRY_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;

export class RecordingOutbox {
  private status = { ...EMPTY_SYNC_STATUS };
  private listeners = new Set<(status: RecordingSyncStatus) => void>();
  private writing: Promise<void> = Promise.resolve();
  private uploading: Promise<void> | null = null;
  private retryAfter = new Map<string, number>();
  private volatileReadings = new Map<string, StoredReading>();

  constructor(
    private storage: RecordingStorage = new IndexedDbRecordingStorage(),
    private fetcher: typeof fetch = (...args) => fetch(...args),
    private now = () => Date.now(),
  ) {}

  subscribe(listener: (status: RecordingSyncStatus) => void) {
    this.listeners.add(listener);
    listener(this.status);
    return () => { this.listeners.delete(listener); };
  }

  private emit() { for (const listener of this.listeners) listener({ ...this.status }); }

  private async refresh() {
    const sessions = await this.storage.listSessions();
    this.status = {
      ...this.status, sessions,
      pendingReadings: sessions.reduce((sum, session) => sum + session.person1Count + session.person2Count - session.acknowledgedCount, 0) + this.volatileReadings.size,
      pendingSessions: sessions.filter((session) => session.serverSessionId === null || (session.endedAt !== null && !session.endAcknowledged)).length,
      localWrites: this.volatileReadings.size,
    };
    this.emit();
  }

  async initialize() {
    try {
      await this.storage.open();
      this.status.ready = true;
      this.status.storageError = null;
      await this.refresh();
    } catch (error) {
      this.status.storageError = error instanceof Error ? error.message : String(error);
      this.emit();
      throw error;
    }
  }

  private write(operation: () => Promise<void>) {
    const pending = this.writing.then(operation);
    this.writing = pending.catch(() => {});
    return pending;
  }

  async createSession(session: RecordingSession) {
    await this.write(() => this.storage.createSession(session));
    await this.refresh();
  }

  async getSession(id: string) { await this.writing; return this.storage.getSession(id); }

  async updateSession(id: string, patch: Partial<RecordingSession>) {
    await this.write(() => this.storage.updateSession(id, patch));
    await this.refresh();
  }

  async append(id: string, reading: RecordedReading) {
    const stored: StoredReading = { ...reading, clientSessionId: id, uploaded: 0 };
    this.volatileReadings.set(reading.sampleId, stored);
    this.status.localWrites = this.volatileReadings.size;
    this.emit();
    try {
      await this.write(() => this.storage.addReading(stored));
      this.volatileReadings.delete(reading.sampleId);
      if (this.volatileReadings.size === 0) this.status.storageError = null;
    } catch (error) {
      // Retain in memory for another persistence attempt; never claim it is saved.
      this.status.storageError = error instanceof Error ? error.message : String(error);
    }
    await this.refresh();
  }

  async snapshot(id: string, from: number, to: number): Promise<BiometricReading[]> {
    await this.writing;
    const stored = await this.storage.readings(id, false);
    return stored.filter((reading) => reading.timestamp >= from && reading.timestamp <= to)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async retire(id: string) {
    await this.updateSession(id, { retired: true });
    if (!this.hasVolatile(id)) await this.storage.prune(id);
    await this.refresh();
  }

  private hasVolatile(id: string) {
    return [...this.volatileReadings.values()].some((reading) => reading.clientSessionId === id);
  }

  private async post(url: string, body: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Saving failed (${response.status}); measurements remain queued`);
      return await response.json();
    } finally { clearTimeout(timeout); }
  }

  flush(): Promise<void> {
    if (!this.status.ready) return Promise.resolve();
    if (this.uploading) return this.uploading;
    const operation = this.upload();
    this.uploading = operation;
    void operation.finally(() => { if (this.uploading === operation) this.uploading = null; });
    return operation;
  }

  private async upload() {
    this.status.uploading = true;
    this.emit();
    let failure: string | null = null;
    try {
      await this.writing;
      for (const reading of this.volatileReadings.values()) {
        await this.write(() => this.storage.addReading(reading));
        this.volatileReadings.delete(reading.sampleId);
      }
      if (this.volatileReadings.size === 0) this.status.storageError = null;
      const sessions = (await this.storage.listSessions()).sort((a, b) => a.startedAt - b.startedAt);
      for (const session of sessions) {
        const id = session.clientSessionId;
        if ((this.retryAfter.get(id) ?? 0) > this.now()) continue;
        try {
          let serverId = session.serverSessionId;
          if (serverId === null) {
            const created = await this.post("/api/sessions", { clientSessionId: id, startedAt: session.startedAt, notes: session.notes });
            if (!Number.isSafeInteger(created.sessionId) || Number(created.sessionId) <= 0 || created.clientSessionId !== id) {
              throw new Error("Server did not acknowledge the recording session");
            }
            serverId = Number(created.sessionId);
            await this.write(() => this.storage.updateSession(id, { serverSessionId: serverId }));
          }
          // Bounded work per pass; a continuously growing stream cannot monopolize the worker.
          for (let batchNumber = 0; batchNumber < 10; batchNumber++) {
            await this.writing;
            const batch = await this.storage.readings(id, true, BATCH_SIZE);
            if (batch.length === 0) break;
            const readings = batch.map((reading) => ({
              sampleId: reading.sampleId, personId: reading.personId, timestamp: reading.timestamp,
              heartRate: reading.heartRate, spo2: reading.spo2, temperature: reading.temperature,
              hrv: reading.hrv, rawPpg: reading.rawPpg, accelX: reading.accelX,
              accelY: reading.accelY, accelZ: reading.accelZ,
            }));
            const response = await this.post("/api/readings", { sessionId: serverId, readings });
            const batchIds = new Set(batch.map((reading) => reading.sampleId));
            const acknowledged = response.acknowledgedSampleIds;
            if (!Array.isArray(acknowledged) || !acknowledged.every((sampleId) => typeof sampleId === "string" && batchIds.has(sampleId))) {
              throw new Error("Server did not acknowledge the measurement IDs");
            }
            await this.write(() => this.storage.acknowledge(id, acknowledged));
            if (new Set(acknowledged).size !== batchIds.size) throw new Error("Some measurements are still awaiting acknowledgement");
          }
          await this.writing;
          const latest = await this.storage.getSession(id);
          if (latest && latest.endedAt !== null && !latest.endAcknowledged && !this.hasVolatile(id) && latest.acknowledgedCount === latest.person1Count + latest.person2Count) {
            const ended = await this.post("/api/sessions", { action: "end", sessionId: serverId, clientSessionId: id, endedAt: latest.endedAt });
            if (ended.ok !== true) throw new Error("Server did not acknowledge the session end");
            await this.write(() => this.storage.updateSession(id, { endAcknowledged: true }));
          }
          if (!this.hasVolatile(id)) await this.storage.prune(id);
          this.retryAfter.delete(id);
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
          this.retryAfter.set(id, this.now() + RETRY_MS);
        }
      }
      if (failure) this.status.networkError = failure;
      else if (this.retryAfter.size === 0) this.status.networkError = null;
    } catch (error) {
      this.status.storageError = error instanceof Error ? error.message : String(error);
    } finally {
      this.status.uploading = false;
      try { await this.refresh(); }
      catch (error) {
        this.status.storageError = error instanceof Error ? error.message : String(error);
        this.emit();
      }
    }
  }
}
