import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { MergeBaseStore } from '../../../src/data/MergeBaseStore';
import { CleanSideStore } from '../../../src/data/CleanSideStore';
import { classifyDirectories } from '../../../src/sync/directory/classify';
import { CreationTimeAligner } from '../../../src/sync/ctime/CreationTimeAligner';
import { computeSyncScopeFingerprint } from '../../../src/sync/plugins/scopeFingerprint';
import {
  DEFAULT_SETTINGS, DavSyncSettings, NextcloudFeatures, RemoteDirInfo, RemoteFileInfo,
  RemoteRootMissingError,
} from '../../../src/types';
import { sha256 } from '../../../src/util/hash';
import { TFile, TFolder } from '../support/obsidian';

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';
const MTIME = 1_000;

function makeDiskAdapter(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  return {
    store,
    adapter: {
      read: jest.fn(async (p: string) => store[p] ?? ''),
      write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
      exists: jest.fn(async (p: string) => p in store),
      remove: jest.fn(async (p: string) => { delete store[p]; }),
      rename: jest.fn(async (f: string, t: string) => { store[t] = store[f]; delete store[f]; }),
      stat: jest.fn(),
      list: jest.fn(),
      readBinary: jest.fn(),
      writeBinary: jest.fn(),
    } as unknown as DataAdapter,
  };
}

interface RemoteEntry {
  body: string;
  checksum: string;
  mtime: number;
  creationTime?: number;
}

function makeServer(opts: { rootMissing?: boolean } = {}) {
  const files = new Map<string, RemoteEntry>();
  const dirs = new Set<string>();
  let rootMissing = opts.rootMissing === true;
  let version = 1;

  const setRemoteFile = async (path: string, body: string, mtime = MTIME): Promise<void> => {
    const checksum = await sha256(toBuf(body));
    files.set(path, { body, checksum, mtime });
    version++;
  };

  const infoOf = (path: string, e: RemoteEntry): RemoteFileInfo => ({
    path,
    fileId: `id:${path}`,
    checksum: e.checksum,
    etag: `etag-${e.checksum.slice(0, 8)}`,
    size: enc.encode(e.body).length,
    lastModified: e.mtime,
    creationTime: e.creationTime,
  });

  const client = {
    files,
    dirs,
    getRootEtag: jest.fn(async (): Promise<string | null> => (rootMissing ? null : `root-etag-${version}`)),
    getFiles: jest.fn(async (path: string): Promise<RemoteFileInfo[]> => {
      if (path === '' && rootMissing) throw new RemoteRootMissingError();
      if (path !== '') {
        const entry = files.get(path);
        return entry ? [infoOf(path, entry)] : [];
      }
      return [...files.entries()].map(([p, e]) => infoOf(p, e));
    }),
    getSyncToken: jest.fn(async (): Promise<string | null> => null),
    getChanges: jest.fn(async () => { throw new Error('getChanges should not be reached'); }),
    createVaultRoot: jest.fn(async () => 'created' as const),
    getDirectories: jest.fn(async (): Promise<RemoteDirInfo[]> =>
      [...dirs].map((p) => ({ path: p, fileId: `dir:${p}`, etag: null, lastModified: 0 }))),
    createDirectory: jest.fn(async (p: string) => { dirs.add(p); version++; }),
    uploadFile: jest.fn(async () => { throw new Error('uploadFile must never be called in one-way sync'); }),
    downloadFile: jest.fn(async (p: string) => toBuf(files.get(p)?.body ?? '')),
    statFile: jest.fn(async (p: string) => (files.has(p) ? infoOf(p, files.get(p)!) : null)),
    remoteExists: jest.fn(async (p: string) => files.has(p) || dirs.has(p)),
    deleteFile: jest.fn(async () => { throw new Error('deleteFile must never be called in one-way sync'); }),
    deleteCollection: jest.fn(async () => { throw new Error('deleteCollection must never be called in one-way sync'); }),
    moveFile: jest.fn(async () => { throw new Error('moveFile must never be called in one-way sync'); }),
    isRemoteDirEmpty: jest.fn(async () => true),
    recalcChecksum: jest.fn(async (p: string) => files.get(p)?.checksum ?? null),
    setCreationTime: jest.fn(async () => 'applied' as const),
  };

  return {
    client,
    setRemoteFile,
    deleteRemoteFile: (p: string) => { files.delete(p); version++; },
    addRemoteDir: (p: string) => { dirs.add(p); version++; },
    deleteRemoteDir: (p: string) => { dirs.delete(p); version++; },
    setRootMissing: (missing: boolean) => { rootMissing = missing; },
  };
}

function makeVault(initialFiles: Record<string, string>, initialFolders: string[] = []) {
  const files: Record<string, string> = { ...initialFiles };
  const folders = new Set<string>(initialFolders);
  const trashed: string[] = [];
  const sizeOf = (p: string): number => enc.encode(files[p]).length;

  const localAdapter = {
    files,
    ignore: jest.fn(),
    shouldIgnore: jest.fn(() => false),
    creationTimeSupport: jest.fn(async () => 'untrusted' as const),
    setCreationTime: jest.fn(async () => 'ineffective' as const),
    listVaultFiles: jest.fn(() => Object.keys(files).map((p) => ({ path: p, size: sizeOf(p), mtime: MTIME }))),
    list: jest.fn(async () => ({ files: [] as string[], folders: [] as string[] })),
    stat: jest.fn(async (p: string) => (p in files ? { size: sizeOf(p), mtime: MTIME } : null)),
    exists: jest.fn(async (p: string) => p in files),
    read: jest.fn(async (p: string) => files[p] ?? ''),
    readBinary: jest.fn(async (p: string) => toBuf(files[p] ?? '')),
    atomicWrite: jest.fn(async (p: string, d: string) => { files[p] = d; }),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    remove: jest.fn(async (p: string) => { delete files[p]; }),
  };

  const app = {
    vault: {
      adapter: {
        mkdir: jest.fn(async (p: string) => { folders.add(p); }),
        exists: jest.fn(async (p: string) => p in files || folders.has(p)),
        remove: jest.fn(async (p: string) => { delete files[p]; folders.delete(p); }),
      },
      getAllFolders: () => [...folders].map((p) => new TFolder(p)),
      getAbstractFileByPath: (p: string) => {
        if (folders.has(p)) return new TFolder(p);
        return p in files ? new TFile(p) : null;
      },
    },
    fileManager: {
      trashFile: jest.fn(async (f: TFile | TFolder) => {
        trashed.push(f.path);
        if (f instanceof TFolder) {
          folders.delete(f.path);
          for (const k of Object.keys(files)) {
            if (k.startsWith(`${f.path}/`)) delete files[k];
          }
        } else {
          delete files[f.path];
        }
      }),
    },
  };

  return { localAdapter, app, files, folders, trashed };
}

async function createOneWayHarness(opts: {
  localFiles?: Record<string, string>;
  localFolders?: string[];
  remoteFiles?: Record<string, string>;
  remoteDirs?: string[];
  rootMissing?: boolean;
  settings?: Partial<DavSyncSettings>;
} = {}) {
  const { adapter: stateAdapter } = makeDiskAdapter();
  const stateDB = new StateDB(stateAdapter, PLUGIN_DIR, 'dev1');
  await stateDB.load();

  const vault = makeVault(opts.localFiles ?? {}, opts.localFolders ?? []);
  const server = makeServer({ rootMissing: opts.rootMissing });
  for (const [p, body] of Object.entries(opts.remoteFiles ?? {})) {
    await server.setRemoteFile(p, body);
  }
  for (const d of opts.remoteDirs ?? []) {
    server.addRemoteDir(d);
  }

  const baseStoreSpy = {
    get: jest.fn(() => undefined),
    set: jest.fn(),
    delete: jest.fn(),
    requestSave: jest.fn(),
    flush: jest.fn(async () => undefined),
  };

  const features: NextcloudFeatures = {
    isNextcloud: true,
    version: '30',
    hasChecksums: true,
    hasFilesLocking: false,
    hasBulkUpload: false,
    hasAccountDav: true,
    syncToken: null,
  };
  const statusBar = { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn() };
  const settings: DavSyncSettings = {
    ...DEFAULT_SETTINGS,
    oneWaySync: true,
    syncOnWifiOnly: false,
    ...opts.settings,
  };

  const engine = new SyncEngine({
    app: vault.app,
    settings,
    localAdapter: vault.localAdapter,
    stateDB,
    baseStore: baseStoreSpy,
    statusBar,
    webdavFactory: { createClient: jest.fn(async () => ({ client: server.client, features })) },
    pluginDir: PLUGIN_DIR,
    configDir: '.obsidian',
  } as never);

  return { engine, stateDB, vault, server, baseStoreSpy, settings };
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
});

describe('One-way sync — snapshot memory and disk cleanup', () => {
  it('MergeBaseStore.purgeFiles deletes .json and .tmp without reading them into memory', async () => {
    const { store, adapter } = makeDiskAdapter({
      [`${PLUGIN_DIR}/merge-base-dev1.json`]: '{"huge.md":"A".repeat(1000000)}',
      [`${PLUGIN_DIR}/merge-base-dev1.json.tmp`]: '{"huge.md":"tmp"}',
    });
    await MergeBaseStore.purgeFiles(adapter, PLUGIN_DIR, 'dev1');
    expect(adapter.read).not.toHaveBeenCalled();
    expect(store[`${PLUGIN_DIR}/merge-base-dev1.json`]).toBeUndefined();
    expect(store[`${PLUGIN_DIR}/merge-base-dev1.json.tmp`]).toBeUndefined();
  });

  it('MergeBaseStore.clearAndPurge clears in-memory bases, cancels save timers, and removes files', async () => {
    const { store, adapter } = makeDiskAdapter();
    const baseStore = new MergeBaseStore(adapter, PLUGIN_DIR, 'dev1');
    baseStore.set('note.md', 'large markdown content');
    await baseStore.save();
    expect(store[`${PLUGIN_DIR}/merge-base-dev1.json`]).toBeDefined();

    await baseStore.clearAndPurge();
    expect(baseStore.get('note.md')).toBeUndefined();
    expect(store[`${PLUGIN_DIR}/merge-base-dev1.json`]).toBeUndefined();
  });

  it('CleanSideStore.purgeFiles and clearAndPurge remove conflict snapshots without reading', async () => {
    const { store, adapter } = makeDiskAdapter({
      [`${PLUGIN_DIR}/conflict-clean-dev1.json`]: '{"note.md":{}}',
      [`${PLUGIN_DIR}/conflict-clean-dev1.json.tmp`]: '{}',
    });
    await CleanSideStore.purgeFiles(adapter, PLUGIN_DIR, 'dev1');
    expect(adapter.read).not.toHaveBeenCalled();
    expect(store[`${PLUGIN_DIR}/conflict-clean-dev1.json`]).toBeUndefined();
    expect(store[`${PLUGIN_DIR}/conflict-clean-dev1.json.tmp`]).toBeUndefined();

    const cleanStore = new CleanSideStore(adapter, PLUGIN_DIR, 'dev1');
    cleanStore.set('a.md', { local: 'L', remote: 'R', localMtime: 1, remoteMtime: 2, localSize: 1, remoteSize: 1 });
    await cleanStore.save();
    expect(cleanStore.size()).toBe(1);
    await cleanStore.clearAndPurge();
    expect(cleanStore.size()).toBe(0);
    expect(store[`${PLUGIN_DIR}/conflict-clean-dev1.json`]).toBeUndefined();
  });

  it('never records merge-base snapshots for markdown or text files during one-way sync', async () => {
    const { engine, baseStoreSpy, vault } = await createOneWayHarness({
      remoteFiles: { 'note.md': '# Server note', 'code.txt': 'server text' },
    });
    await engine.syncManual({ manual: true });
    expect(vault.files['note.md']).toBe('# Server note');
    expect(vault.files['code.txt']).toBe('server text');
    expect(baseStoreSpy.set).not.toHaveBeenCalled();
  });
});

describe('One-way sync — initial and incremental reconciliation (server authoritative)', () => {
  it('initial sync downloads remote files, keeps identical files without transfer, trashes local-only files, and never uploads', async () => {
    const { engine, vault, server } = await createOneWayHarness({
      localFiles: {
        'same.md': 'identical body',
        'differ.md': 'local draft to discard',
        'local-only.md': 'scratch note not on server',
      },
      remoteFiles: {
        'same.md': 'identical body',
        'differ.md': 'authoritative server body',
        'remote-only.md': 'new from server',
      },
    });

    await engine.syncManual({ manual: true });

    expect(vault.files['same.md']).toBe('identical body');
    expect(vault.files['differ.md']).toBe('authoritative server body');
    expect(vault.files['remote-only.md']).toBe('new from server');
    expect(vault.files['local-only.md']).toBeUndefined();
    expect(vault.trashed).toContain('local-only.md');
    expect(server.client.uploadFile).not.toHaveBeenCalled();
    // `same.md` matched by server checksum, so it was not downloaded.
    const downloadedPaths = server.client.downloadFile.mock.calls.map((c) => c[0]);
    expect(downloadedPaths).not.toContain('same.md');
  });

  it('incremental sync overwrites local edits, restores locally deleted files, and trashes local-only and remotely-deleted files', async () => {
    const { engine, vault, server } = await createOneWayHarness({
      remoteFiles: {
        'keep.md': 'unchanged server content',
        'edited-locally.md': 'clean server version',
        'deleted-locally.md': 'must come back from server',
        'deleted-on-server.md': 'will be deleted on server',
      },
    });

    // First sync converges local vault with server.
    await engine.syncManual({ manual: true });
    server.client.downloadFile.mockClear();
    vault.localAdapter.readBinary.mockClear();

    // Mutate both sides before the second sync:
    // 1. Local edit on phone (must be overwritten by server, never merged or uploaded)
    vault.files['edited-locally.md'] = 'accidental phone edit';
    // 2. Local deletion on phone (must be restored from server, never deleted on server)
    delete vault.files['deleted-locally.md'];
    // 3. New local-only file on phone (must be trashed, never uploaded)
    vault.files['phone-scratch.md'] = 'temporary local file';
    // 4. Remote deletion + local edit on phone (must still be trashed because server deleted it)
    vault.files['deleted-on-server.md'] = 'edited locally before server delete';
    server.deleteRemoteFile('deleted-on-server.md');

    await engine.syncManual({ manual: true });

    expect(vault.files['keep.md']).toBe('unchanged server content');
    expect(vault.files['edited-locally.md']).toBe('clean server version');
    expect(vault.files['deleted-locally.md']).toBe('must come back from server');
    expect(vault.files['phone-scratch.md']).toBeUndefined();
    expect(vault.files['deleted-on-server.md']).toBeUndefined();
    expect(vault.trashed).toEqual(expect.arrayContaining(['phone-scratch.md', 'deleted-on-server.md']));

    // Fast-path: `keep.md` was neither read nor re-downloaded.
    expect(server.client.downloadFile.mock.calls.map((c) => c[0])).not.toContain('keep.md');
    expect(server.client.uploadFile).not.toHaveBeenCalled();
    expect(server.client.deleteFile).not.toHaveBeenCalled();
    expect(server.client.moveFile).not.toHaveBeenCalled();
  });

  it('refuses to create remote root or wipe local vault when remote vault folder is missing (404)', async () => {
    const { engine, vault, server } = await createOneWayHarness({
      localFiles: { 'precious.md': 'keep safe' },
      rootMissing: true,
    });

    await engine.syncManual({ manual: true });

    expect(server.client.createVaultRoot).not.toHaveBeenCalled();
    expect(server.client.uploadFile).not.toHaveBeenCalled();
    expect(vault.files['precious.md']).toBe('keep safe');
    expect(vault.trashed).toEqual([]);
    expect(engine.getLastSessionSummary()?.errorCount).toBe(1);
  });
});

describe('One-way sync — directories, creation time, watch mode, and guards', () => {
  it('classifyDirectories in one-way mode never plans mkcolRemote or deleteRemote', () => {
    const remoteDirs = new Map<string, RemoteDirInfo>([
      ['remote-new', { path: 'remote-new', fileId: 'd1', etag: null, lastModified: 0 }],
      ['deleted-locally', { path: 'deleted-locally', fileId: 'd2', etag: null, lastModified: 0 }],
    ]);
    const localDirs = new Set<string>(['local-new', 'deleted-remotely']);
    const tracked = new Map([
      ['deleted-locally', { path: 'deleted-locally', remoteFileId: 'd2' }],
      ['deleted-remotely', { path: 'deleted-remotely', remoteFileId: 'd3' }],
    ]);

    const plan = classifyDirectories(remoteDirs, localDirs, tracked, () => false, true);
    expect(plan.mkcolRemote).toEqual([]);
    expect(plan.deleteRemote).toEqual([]);
    expect(plan.mkdirLocal.sort()).toEqual(['deleted-locally', 'remote-new']);
    expect(plan.trashLocal.sort()).toEqual(['deleted-remotely', 'local-new']);
  });

  it('CreationTimeAligner never updates server creation time when isOneWaySync is true', async () => {
    const stateDB = new StateDB(makeDiskAdapter().adapter, PLUGIN_DIR, 'dev1');
    await stateDB.load();
    const setCreationTime = jest.fn(async () => 'applied' as const);
    const aligner = new CreationTimeAligner({
      localAdapter: {
        stat: jest.fn(async () => ({ size: 10, mtime: 5000, ctime: 1000 })),
        setCreationTime: jest.fn(async () => 'applied' as const),
        creationTimeSupport: jest.fn(async () => 'settable' as const),
      },
      stateDB,
      isBeingEdited: () => false,
      isOneWaySync: () => true,
    });

    // Local ctime (1000ms) is older than remote creationTime (9000ms): bidirectional would push 1s to server,
    // but one-way sync must not mutate the server.
    await aligner.align(
      { setCreationTime } as never,
      { path: 'note.md', fileId: '1', checksum: null, etag: 'e', size: 10, lastModified: 5000, creationTime: 9000 },
    );
    expect(setCreationTime).not.toHaveBeenCalled();
  });

  it('watch operations and manual push methods are blocked in one-way sync mode', async () => {
    const { engine, server } = await createOneWayHarness({
      localFiles: { 'a.md': 'local' },
      remoteFiles: { 'a.md': 'remote' },
    });

    await engine.syncSingleFile('a.md');
    await engine.deleteSingleFile('a.md');
    await engine.renameSingleFile('a.md', 'b.md');
    await engine.createSingleFolder('dir');
    await engine.deleteSingleFolder('dir');
    await engine.renameSingleFolder('dir', 'dir2');

    expect(server.client.statFile).not.toHaveBeenCalled();
    expect(server.client.createDirectory).not.toHaveBeenCalled();
    expect(server.client.deleteCollection).not.toHaveBeenCalled();
    expect(server.client.moveFile).not.toHaveBeenCalled();

    await expect(engine.pushLocalToRemote('a.md')).rejects.toThrow(/one-way sync/i);
    await expect(engine.applyCleanLocal('a.md')).rejects.toThrow(/one-way sync/i);
  });

  it('computeSyncScopeFingerprint distinguishes one-way sync while keeping bidirectional backward-compatible', () => {
    const base = {
      syncConfigFolder: false,
      configSync: { bookmarks: true, others: true },
      excludedFolders: [],
      syncedCommunityPlugins: [],
    };
    expect(computeSyncScopeFingerprint({ ...base, oneWaySync: false })).toBe(computeSyncScopeFingerprint(base));
    expect(computeSyncScopeFingerprint({ ...base, oneWaySync: true })).not.toBe(computeSyncScopeFingerprint(base));
  });
});
