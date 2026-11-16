import { DataAdapter, Platform } from 'obsidian';
import { AsyncMutex } from '../util/AsyncMutex';

const TMP_SUFFIX = '.tmp';
const SAVE_DEBOUNCE_MS = 2000;
// Android Capacitor FilesystemPlugin.readFile JSON-escapes the whole file on a ~256 MB Java heap;
// reading a larger merge-base store crash-loops the app on startup before settings can even be opened.
const MAX_MOBILE_MERGE_BASE_BYTES = 20 * 1024 * 1024;

// Last-synced body of each Auto Merge File, the common ancestor for 3-way conflict merges. Without a real base,
// reconcile-text duplicates the blocks both sides share. Kept out of StateDB (high-churn metadata) to avoid bloating its saves.
// Only a quality hint: a missing/stale base falls back to base='' (the expansion guard prevents a corrupt write) and re-seeds at the next convergence.
export class MergeBaseStore {
  private bases: Record<string, string> = {};
  private readonly storePath: string;
  private readonly tmpPath: string;
  private readonly saveMutex = new AsyncMutex();
  private saveTimer: number | null = null;

  constructor(
    private readonly adapter: DataAdapter,
    pluginDir: string,
    deviceId: string,
  ) {
    this.storePath = `${pluginDir}/merge-base-${deviceId}.json`;
    this.tmpPath = this.storePath + TMP_SUFFIX;
  }

  async load(): Promise<void> {
    try {
      let readPath = this.storePath;
      let recoveredFromTmp = false;
      if (!(await this.adapter.exists(readPath))) {
        // A crash between remove(storePath) and rename(tmpPath, storePath) leaves only tmp: recover from it.
        if (!(await this.adapter.exists(this.tmpPath))) return;
        readPath = this.tmpPath;
        recoveredFromTmp = true;
      }
      if (Platform.isMobile && typeof this.adapter.stat === 'function') {
        const st = await this.adapter.stat(readPath);
        if (st && st.size > MAX_MOBILE_MERGE_BASE_BYTES) {
          console.warn(
            `[MergeBaseStore] Skipping oversized merge-base store (${(st.size / 1024 / 1024).toFixed(1)} MB) on mobile to prevent OutOfMemoryError`,
          );
          return;
        }
      }
      const raw = await this.adapter.read(readPath);
      const parsed = JSON.parse(raw) as Record<string, string>;
      if (parsed && typeof parsed === 'object') this.bases = parsed;
      if (recoveredFromTmp) {
        // Best-effort; the next save() recreates storePath from the in-memory bases.
        await this.adapter.rename(this.tmpPath, this.storePath).catch(() => undefined);
      }
    } catch {
      // Corrupted store: start empty; bases re-seed at the next convergence.
      console.warn('[MergeBaseStore] Failed to parse merge-base store; starting empty');
    }
  }

  get(path: string): string | undefined {
    return this.bases[path];
  }

  set(path: string, body: string): void {
    this.bases[path] = body;
  }

  delete(path: string): void {
    delete this.bases[path];
  }

  // Serialized so concurrent saves never race the unlink step.
  save(): Promise<void> {
    return this.saveMutex.run(() => this.doSave());
  }

  requestSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.save();
      return;
    }
    await this.saveMutex.run(() => undefined);
  }

  // Releases in-memory bases and removes persisted snapshot files without serializing anything.
  async clearAndPurge(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.bases = {};
    await this.saveMutex.run(async () => {
      await MergeBaseStore.removeIfExists(this.adapter, this.storePath);
      await MergeBaseStore.removeIfExists(this.adapter, this.tmpPath);
    });
  }

  // Deletes persisted merge-base files without reading or parsing them into memory (avoids OOM on startup).
  static async purgeFiles(adapter: DataAdapter, pluginDir: string, deviceId: string): Promise<void> {
    const storePath = `${pluginDir}/merge-base-${deviceId}.json`;
    await MergeBaseStore.removeIfExists(adapter, storePath);
    await MergeBaseStore.removeIfExists(adapter, storePath + TMP_SUFFIX);
  }

  private static async removeIfExists(adapter: DataAdapter, path: string): Promise<void> {
    try {
      if (await adapter.exists(path)) await adapter.remove(path);
    } catch {
      // Best-effort cleanup: a missing or locked file must not block sync startup.
    }
  }

  private async doSave(): Promise<void> {
    const json = JSON.stringify(this.bases);
    await this.adapter.write(this.tmpPath, json);
    if (await this.adapter.exists(this.storePath)) {
      await this.adapter.remove(this.storePath);
    }
    await this.adapter.rename(this.tmpPath, this.storePath);
  }
}
