import { describe, expect, it } from 'vitest';
import { createLocSpace } from '../../editing/loc-space.ts';
import { makeContext, resolveSlideLoc, withFileLock } from './context.ts';

describe('withFileLock', () => {
  it('runs tasks on the same file one after another', async () => {
    const order: string[] = [];
    const slow = withFileLock('/f', async () => {
      order.push('slow:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('slow:end');
    });
    const fast = withFileLock('/f', async () => {
      order.push('fast');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow:start', 'slow:end', 'fast']);
  });

  it('lets different files run side by side', async () => {
    const order: string[] = [];
    const slow = withFileLock('/a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('a');
    });
    const fast = withFileLock('/b', async () => {
      order.push('b');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['b', 'a']);
  });

  it('keeps going after a task fails', async () => {
    const failed = withFileLock('/g', async () => {
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');
    await expect(withFileLock('/g', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('resolveSlideLoc', () => {
  const locSpace = createLocSpace();
  const ctx = makeContext({
    userCwd: '/repo',
    coreVersion: '0.0.0',
    agentEnabled: false,
    locSpace,
  });

  it('maps an entry line to index.tsx', () => {
    expect(resolveSlideLoc(ctx, 'deck', 7)).toMatchObject({
      file: 'index.tsx',
      path: '/repo/slides/deck/index.tsx',
      line: 7,
    });
  });

  it('maps a banded line to its deck file', () => {
    const line = locSpace.encode('deck', 'pages/intro.tsx', 7);
    expect(resolveSlideLoc(ctx, 'deck', line)).toMatchObject({
      path: '/repo/slides/deck/pages/intro.tsx',
      line: 7,
    });
  });

  it('refuses files that escape the deck folder', () => {
    const line = locSpace.encode('deck', '../other/index.tsx', 7);
    expect(resolveSlideLoc(ctx, 'deck', line)).toBeNull();
  });
});
