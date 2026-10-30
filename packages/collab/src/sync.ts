import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import { applyTextChange } from './text-diff.ts';

const TEXT_EXTENSIONS = new Set([
  '.tsx',
  '.ts',
  '.jsx',
  '.js',
  '.mjs',
  '.md',
  '.mdx',
  '.json',
  '.css',
  '.svg',
  '.html',
  '.txt',
]);

// Liveblocks rejects oversized updates, and a stray video would bloat every
// workspace that joins the room.
const MAX_BINARY_BYTES = 8 * 1024 * 1024;

const TMP_SUFFIX = '.collab-tmp';

const ECHO_TTL_MS = 5000;

type Entry = Y.Text | Uint8Array;

export type SlidesSyncOptions = {
  root: string;
  doc: Y.Doc;
  backupDir: string;
  log?: (message: string) => void;
};

export type SlidesSync = {
  start(): Promise<void>;
  localChanged(file: string): Promise<void>;
  localRemoved(file: string): void;
  stop(): void;
};

export function isSyncedPath(rel: string): boolean {
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split('/');
  if (parts.some((part) => part.startsWith('.') || part === 'node_modules')) return false;
  const name = parts.at(-1) ?? '';
  return !name.endsWith('~') && !name.endsWith(TMP_SUFFIX) && !name.endsWith('.swp');
}

function fingerprint(data: string | Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

function isText(rel: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase());
}

function entryContent(entry: Entry): string | Uint8Array {
  return entry instanceof Y.Text ? entry.toString() : entry;
}

async function walk(dir: string, base = dir): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (!isSyncedPath(rel)) continue;
    if (entry.isDirectory()) out.push(...(await walk(abs, base)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

export function createSlidesSync(opts: SlidesSyncOptions): SlidesSync {
  const { root, doc } = opts;
  const log = opts.log ?? (() => {});
  const files = doc.getMap<Entry>('files');
  const localOrigin = Symbol('open-slide-collab:local');
  // Contents this process just wrote to disk on the room's behalf. The
  // watcher event each write triggers must not be sent back up, and it may
  // read the file after a later write already landed, so a match drops that
  // echo and every older one. Echoes expire so a user later typing the same
  // content back still syncs.
  const echoes = new Map<string, { fingerprint: string; at: number }[]>();
  const expectEcho = (rel: string, content: string | Uint8Array) => {
    const now = Date.now();
    const recent = (echoes.get(rel) ?? []).filter((e) => now - e.at < ECHO_TTL_MS);
    recent.push({ fingerprint: fingerprint(content), at: now });
    echoes.set(rel, recent);
  };
  const consumeEcho = (rel: string, content: string | Uint8Array): boolean => {
    const recent = echoes.get(rel);
    if (!recent) return false;
    const now = Date.now();
    const fp = fingerprint(content);
    const index = recent.findIndex((e) => e.fingerprint === fp && now - e.at < ECHO_TTL_MS);
    if (index === -1) return false;
    recent.splice(0, index + 1);
    return true;
  };
  let started = false;

  const toRel = (file: string) => path.relative(root, file).split(path.sep).join('/');
  const toAbs = (rel: string) => path.join(root, ...rel.split('/'));

  async function readLocal(rel: string): Promise<string | Uint8Array | null> {
    try {
      const buf = await fs.readFile(toAbs(rel));
      return isText(rel) ? buf.toString('utf8') : new Uint8Array(buf);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async function writeLocal(rel: string, content: string | Uint8Array): Promise<void> {
    const abs = toAbs(rel);
    expectEcho(rel, content);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}${TMP_SUFFIX}`;
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, abs);
  }

  async function removeLocal(rel: string): Promise<void> {
    echoes.delete(rel);
    await fs.rm(toAbs(rel), { force: true });
  }

  async function backup(rel: string, stamp: string): Promise<void> {
    const content = await readLocal(rel);
    if (content === null) return;
    const target = path.join(opts.backupDir, stamp, ...rel.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  function upload(rel: string, content: string | Uint8Array): void {
    const current = files.get(rel);
    if (typeof content === 'string') {
      if (current instanceof Y.Text) {
        applyTextChange(current, content);
      } else {
        const text = new Y.Text();
        text.insert(0, content);
        files.set(rel, text);
      }
    } else if (content.byteLength > MAX_BINARY_BYTES) {
      log(`skipped ${rel}: larger than ${MAX_BINARY_BYTES / 1024 / 1024} MB`);
    } else {
      files.set(rel, content);
    }
  }

  const pendingWrites = new Map<string, Promise<void>>();

  // Writes to one path are chained so a slow write can't land after a newer one.
  function flushRemote(rel: string): void {
    const previous = pendingWrites.get(rel) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const entry = files.get(rel);
        if (entry === undefined) await removeLocal(rel);
        else await writeLocal(rel, entryContent(entry));
      })
      .catch((err) => log(`failed to write ${rel}: ${(err as Error).message}`));
    pendingWrites.set(rel, next);
  }

  const onRemote = (events: Y.YEvent<Y.AbstractType<unknown>>[], tx: Y.Transaction) => {
    if (tx.origin === localOrigin) return;
    const changed = new Set<string>();
    for (const event of events) {
      if (event instanceof Y.YMapEvent && event.target === files) {
        for (const key of event.keysChanged) changed.add(key);
      } else if (typeof event.path[0] === 'string') {
        changed.add(event.path[0]);
      }
    }
    for (const rel of changed) if (isSyncedPath(rel)) flushRemote(rel);
  };

  async function seed(): Promise<void> {
    const local = await walk(root);
    const contents = await Promise.all(
      local.map(async (rel) => [rel, await readLocal(rel)] as const),
    );
    doc.transact(() => {
      for (const [rel, content] of contents) if (content !== null) upload(rel, content);
    }, localOrigin);
    log(`seeded the room with ${local.length} files`);
  }

  // The room is the source of truth: anything local that disagrees with it is
  // copied aside before being overwritten, never silently lost.
  async function materialize(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const local = new Set(await walk(root));
    let replaced = 0;
    for (const [rel, entry] of files.entries()) {
      if (!isSyncedPath(rel)) continue;
      const remote = entryContent(entry);
      const mine = local.has(rel) ? await readLocal(rel) : null;
      local.delete(rel);
      if (mine !== null && fingerprint(mine) === fingerprint(remote)) continue;
      if (mine !== null) {
        await backup(rel, stamp);
        replaced++;
      }
      await writeLocal(rel, remote);
    }
    for (const rel of local) {
      await backup(rel, stamp);
      await removeLocal(rel);
      replaced++;
    }
    if (replaced > 0) {
      log(
        `${replaced} local files differed from the room; copies saved in ${path.join(opts.backupDir, stamp)}`,
      );
    }
  }

  return {
    async start() {
      if (files.size === 0) await seed();
      else await materialize();
      files.observeDeep(onRemote);
      started = true;
    },

    async localChanged(file) {
      if (!started) return;
      const rel = toRel(file);
      if (!isSyncedPath(rel)) return;
      const content = await readLocal(rel);
      if (content === null) return;
      if (consumeEcho(rel, content)) return;
      const current = files.get(rel);
      if (current !== undefined && fingerprint(entryContent(current)) === fingerprint(content))
        return;
      doc.transact(() => upload(rel, content), localOrigin);
    },

    localRemoved(file) {
      if (!started) return;
      const rel = toRel(file);
      if (!isSyncedPath(rel) || !files.has(rel)) return;
      echoes.delete(rel);
      doc.transact(() => files.delete(rel), localOrigin);
    },

    stop() {
      files.unobserveDeep(onRemote);
      started = false;
    },
  };
}
