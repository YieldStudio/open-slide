import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createSlidesSync, isSyncedPath, type SlidesSync } from './sync.ts';

type Peer = { dir: string; doc: Y.Doc; sync: SlidesSync };

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFiles(dir: string, files: Record<string, string | Uint8Array>) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, 'slides', rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

const read = (peer: Peer, rel: string) =>
  fs.readFile(path.join(peer.dir, 'slides', rel), 'utf8').catch(() => null);

// Two docs relayed in memory stand in for two workspaces in one room. Pausing
// the relay queues updates, like two machines editing before either hears
// from the other.
function link(a: Y.Doc, b: Y.Doc) {
  let paused = false;
  const queue: [Y.Doc, Uint8Array][] = [];
  const forward = (target: Y.Doc) => (update: Uint8Array, origin: unknown) => {
    if (origin === 'relay') return;
    if (paused) queue.push([target, update]);
    else Y.applyUpdate(target, update, 'relay');
  };
  a.on('update', forward(b));
  b.on('update', forward(a));
  return {
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      for (const [target, update] of queue.splice(0)) Y.applyUpdate(target, update, 'relay');
    },
  };
}

async function peer(doc: Y.Doc, files: Record<string, string | Uint8Array> = {}): Promise<Peer> {
  const dir = await tempDir();
  await writeFiles(dir, files);
  const sync = createSlidesSync({
    root: path.join(dir, 'slides'),
    doc,
    backupDir: path.join(dir, '.collab-backups'),
  });
  cleanups.push(async () => sync.stop());
  return { dir, doc, sync };
}

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not met in time');
}

async function edit(p: Peer, rel: string, content: string) {
  const abs = path.join(p.dir, 'slides', rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  await p.sync.localChanged(abs);
}

async function pair(files: Record<string, string | Uint8Array>) {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const relay = link(docA, docB);
  const alice = await peer(docA, files);
  await alice.sync.start();
  const bob = await peer(docB);
  await bob.sync.start();
  return { alice, bob, relay };
}

describe('isSyncedPath', () => {
  it('skips dotfiles, node_modules, editor leftovers and temp files', () => {
    expect(isSyncedPath('deck/index.tsx')).toBe(true);
    expect(isSyncedPath('deck/.DS_Store')).toBe(false);
    expect(isSyncedPath('deck/node_modules/x.js')).toBe(false);
    expect(isSyncedPath('deck/index.tsx~')).toBe(false);
    expect(isSyncedPath('deck/index.tsx.collab-tmp')).toBe(false);
    expect(isSyncedPath('../outside.tsx')).toBe(false);
  });
});

describe('createSlidesSync', () => {
  it('seeds an empty room and lets a joining workspace materialize it', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const { bob } = await pair({
      'deck/index.tsx': 'export default [];',
      'deck/pages/intro.tsx': '<h1>Intro</h1>',
      'deck/assets/logo.png': png,
    });
    expect(await read(bob, 'deck/index.tsx')).toBe('export default [];');
    expect(await read(bob, 'deck/pages/intro.tsx')).toBe('<h1>Intro</h1>');
    const logo = await fs.readFile(path.join(bob.dir, 'slides/deck/assets/logo.png'));
    expect(new Uint8Array(logo)).toEqual(png);
  });

  it('carries a local edit to the other workspace', async () => {
    const { alice, bob } = await pair({ 'deck/pages/intro.tsx': '<h1>Intro</h1>' });
    await edit(alice, 'deck/pages/intro.tsx', '<h1>Intro par Alice</h1>');
    await until(
      async () => (await read(bob, 'deck/pages/intro.tsx')) === '<h1>Intro par Alice</h1>',
    );
  });

  it('merges concurrent edits to different parts of one file', async () => {
    const { alice, bob, relay } = await pair({ 'deck/index.tsx': 'top\nmiddle\nbottom\n' });
    relay.pause();
    await edit(alice, 'deck/index.tsx', 'TOP\nmiddle\nbottom\n');
    await edit(bob, 'deck/index.tsx', 'top\nmiddle\nBOTTOM\n');
    relay.resume();

    const merged = 'TOP\nmiddle\nBOTTOM\n';
    await until(async () => (await read(alice, 'deck/index.tsx')) === merged);
    await until(async () => (await read(bob, 'deck/index.tsx')) === merged);
  });

  it('does not send a written file back as a new edit', async () => {
    const { alice, bob } = await pair({ 'deck/index.tsx': 'v1' });
    let bobUploads = 0;
    bob.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin !== 'relay') bobUploads++;
    });
    await edit(alice, 'deck/index.tsx', 'v2');
    await until(async () => (await read(bob, 'deck/index.tsx')) === 'v2');
    await bob.sync.localChanged(path.join(bob.dir, 'slides/deck/index.tsx'));
    expect(bobUploads).toBe(0);
  });

  it('still syncs a user restoring content the room wrote earlier', async () => {
    const { alice, bob } = await pair({ 'deck/index.tsx': 'v1' });
    await edit(alice, 'deck/index.tsx', 'v2');
    await until(async () => (await read(bob, 'deck/index.tsx')) === 'v2');
    await bob.sync.localChanged(path.join(bob.dir, 'slides/deck/index.tsx'));
    await edit(bob, 'deck/index.tsx', 'v1');
    await until(async () => (await read(alice, 'deck/index.tsx')) === 'v1');
  });

  it('propagates deletions', async () => {
    const { alice, bob } = await pair({ 'deck/pages/old.tsx': 'old' });
    const abs = path.join(alice.dir, 'slides/deck/pages/old.tsx');
    await fs.rm(abs);
    alice.sync.localRemoved(abs);
    await until(async () => (await read(bob, 'deck/pages/old.tsx')) === null);
  });

  it('backs up local files that differ from the room before replacing them', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    link(docA, docB);
    const alice = await peer(docA, { 'deck/index.tsx': 'room version' });
    await alice.sync.start();
    const bob = await peer(docB, {
      'deck/index.tsx': 'stale local version',
      'deck/scratch.tsx': 'only on bob',
    });
    await bob.sync.start();

    expect(await read(bob, 'deck/index.tsx')).toBe('room version');
    expect(await read(bob, 'deck/scratch.tsx')).toBeNull();
    expect(await read(alice, 'deck/scratch.tsx')).toBeNull();
    const [stamp] = await fs.readdir(path.join(bob.dir, '.collab-backups'));
    const backups = path.join(bob.dir, '.collab-backups', stamp, 'deck');
    expect(await fs.readFile(path.join(backups, 'index.tsx'), 'utf8')).toBe('stale local version');
    expect(await fs.readFile(path.join(backups, 'scratch.tsx'), 'utf8')).toBe('only on bob');
  });
});
