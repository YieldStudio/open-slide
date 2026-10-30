import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide } from './hook.ts';
import { pagesForFile } from './pages.ts';
import type { CollabState } from './state.ts';
import { toolingFingerprint } from './tooling.ts';

let root: string;
const slides = () => path.join(root, 'slides');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-ws-'));
  await fs.writeFile(path.join(root, 'open-slide.config.ts'), 'export default {};');
  await fs.mkdir(path.join(slides(), 'deck', 'pages'), { recursive: true });
  await fs.writeFile(
    path.join(slides(), 'deck', 'index.tsx'),
    "import Intro from './pages/intro';\nimport Market from './pages/market.tsx';\n\nexport const meta = { title: 'Deck' };\n\nexport default [Intro, Market, Intro];\n",
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeState(patch: Partial<CollabState>) {
  const state: CollabState = {
    user: 'me',
    color: 'red',
    online: true,
    readOnly: false,
    reason: null,
    here: null,
    blockedBy: null,
    locks: [],
    participants: [],
    slidesRoot: slides(),
    port: 5200,
    updatedAt: Date.now(),
    ...patch,
  };
  const file = path.join(root, 'node_modules', '.open-slide', 'collab.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state));
}

describe('pagesForFile', () => {
  it('maps page files to every index that renders them', () => {
    expect(pagesForFile(slides(), 'deck/pages/intro.tsx')).toEqual({
      slideId: 'deck',
      pages: [0, 2],
    });
    expect(pagesForFile(slides(), 'deck/pages/market.tsx')).toEqual({
      slideId: 'deck',
      pages: [1],
    });
  });

  it('treats the entry as the whole deck and shared files as no page', () => {
    expect(pagesForFile(slides(), 'deck/index.tsx')).toEqual({ slideId: 'deck', pages: 'all' });
    expect(pagesForFile(slides(), 'deck/pages/frame.tsx')).toBeNull();
  });
});

describe('decide (Claude Code hook)', () => {
  const intro = () => path.join(slides(), 'deck', 'pages', 'intro.tsx');

  it('ignores files outside slides/', async () => {
    expect(decide(path.join(root, 'themes', 'x.md')).allow).toBe(true);
    expect(decide('/somewhere/else.tsx').allow).toBe(true);
  });

  it('blocks slide edits while the dev server is not running', async () => {
    expect(decide(intro()).allow).toBe(false);
    await writeState({ updatedAt: Date.now() - 60_000 });
    expect(decide(intro()).allow).toBe(false);
  });

  it('blocks edits in a read-only workspace', async () => {
    await writeState({ readOnly: true, reason: 'outillage pas à jour' });
    const decision = decide(intro());
    expect(decision.allow).toBe(false);
    expect(!decision.allow && decision.reason).toContain('outillage pas à jour');
  });

  it('blocks a page file someone else holds, and allows the rest', async () => {
    await writeState({ locks: [{ slideId: 'deck', page: 1, user: 'Bob', color: 'blue' }] });
    const market = decide(path.join(slides(), 'deck', 'pages', 'market.tsx'));
    expect(market.allow).toBe(false);
    expect(!market.allow && market.reason).toContain('Bob');
    expect(decide(intro()).allow).toBe(true);
    expect(decide(path.join(slides(), 'deck', 'index.tsx')).allow).toBe(false);
  });
});

describe('toolingFingerprint', () => {
  it('changes with themes and ignores slides', async () => {
    await fs.mkdir(path.join(root, 'themes'));
    await fs.writeFile(path.join(root, 'themes', 'yield.md'), 'v1');
    const before = await toolingFingerprint(root);
    await fs.writeFile(path.join(slides(), 'deck', 'pages', 'intro.tsx'), 'changed');
    expect(await toolingFingerprint(root)).toBe(before);
    await fs.writeFile(path.join(root, 'themes', 'yield.md'), 'v2');
    expect(await toolingFingerprint(root)).not.toBe(before);
  });
});
