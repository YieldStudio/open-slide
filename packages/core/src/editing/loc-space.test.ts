import { describe, expect, it } from 'vitest';
import { createLocSpace, LOC_FILE_STRIDE, sourceLine } from './loc-space.ts';

describe('createLocSpace', () => {
  it('leaves entry lines untouched', () => {
    const space = createLocSpace();
    expect(space.encode('deck', 'index.tsx', 42)).toBe(42);
    expect(space.decode('deck', 42)).toEqual({ file: 'index.tsx', line: 42 });
  });

  it('gives each other file its own band, stable across encodes', () => {
    const space = createLocSpace();
    const a = space.encode('deck', 'pages/a.tsx', 3);
    const b = space.encode('deck', 'pages/b.tsx', 3);
    expect(a).not.toBe(b);
    expect(space.encode('deck', 'pages/a.tsx', 9)).toBe(a - 3 + 9);
    expect(space.decode('deck', a)).toEqual({ file: 'pages/a.tsx', line: 3 });
    expect(space.decode('deck', b)).toEqual({ file: 'pages/b.tsx', line: 3 });
  });

  it('numbers bands per deck', () => {
    const space = createLocSpace();
    space.encode('one', 'pages/a.tsx', 1);
    const other = space.encode('two', 'pages/z.tsx', 1);
    expect(space.decode('two', other)?.file).toBe('pages/z.tsx');
    expect(space.decode('one', other)?.file).toBe('pages/a.tsx');
  });

  it('rejects a band it never handed out', () => {
    expect(createLocSpace().decode('deck', 5 * LOC_FILE_STRIDE + 1)).toBeNull();
  });

  it('lists the entry first, then files in band order', () => {
    const space = createLocSpace();
    space.encode('deck', 'pages/b.tsx', 1);
    space.encode('deck', 'pages/a.tsx', 1);
    expect(space.files('deck')).toEqual(['index.tsx', 'pages/b.tsx', 'pages/a.tsx']);
  });
});

describe('sourceLine', () => {
  it('strips the file band', () => {
    expect(sourceLine(12)).toBe(12);
    expect(sourceLine(2 * LOC_FILE_STRIDE + 12)).toBe(12);
  });
});
