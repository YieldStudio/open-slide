import { describe, expect, it } from 'vitest';
import { lockFor, locksHeldByOthers, type Participant, pageHolders } from './locks.ts';

const now = 1_000_000;
const p = (
  connectionId: number,
  user: string,
  page: number | null,
  since: number,
  extra: Partial<Participant> = {},
): Participant => ({
  connectionId,
  user,
  color: 'red',
  slideId: page === null ? null : 'deck',
  page,
  since,
  at: now,
  readOnly: false,
  ...extra,
});

describe('pageHolders', () => {
  it('gives a page to whoever arrived first, ties to the lower connection id', () => {
    const holders = pageHolders(
      [p(2, 'bob', 1, 50), p(1, 'alice', 1, 90), p(3, 'eve', 2, 10), p(4, 'zoe', 2, 10)],
      now,
    );
    expect(holders.get('deck#1')?.user).toBe('bob');
    expect(holders.get('deck#2')?.user).toBe('eve');
  });

  it('ignores stale and read-only participants', () => {
    const holders = pageHolders(
      [
        p(1, 'ghost', 1, 1, { at: now - 60_000 }),
        p(2, 'outdated', 1, 2, { readOnly: true }),
        p(3, 'bob', 1, 3),
      ],
      now,
    );
    expect(holders.get('deck#1')?.user).toBe('bob');
  });
});

describe('locksHeldByOthers', () => {
  it('lists pages others hold, not the ones I hold', () => {
    const me = p(1, 'alice', 0, 5);
    const locks = locksHeldByOthers(me, [p(2, 'bob', 0, 9), p(3, 'eve', 2, 1)], now);
    expect(locks).toEqual([{ slideId: 'deck', page: 2, user: 'eve', color: 'red' }]);
  });

  it('reports a page I arrived on after someone else', () => {
    const me = p(1, 'alice', 0, 9);
    expect(locksHeldByOthers(me, [p(2, 'bob', 0, 5)], now)[0]?.user).toBe('bob');
  });
});

describe('lockFor', () => {
  const locks = [{ slideId: 'deck', page: 2, user: 'eve', color: 'red' }];
  it('matches a file rendering a locked page, or the whole deck', () => {
    expect(lockFor(locks, { slideId: 'deck', pages: [2] })?.user).toBe('eve');
    expect(lockFor(locks, { slideId: 'deck', pages: 'all' })?.user).toBe('eve');
    expect(lockFor(locks, { slideId: 'deck', pages: [0, 1] })).toBeNull();
    expect(lockFor(locks, { slideId: 'other', pages: 'all' })).toBeNull();
  });
});
