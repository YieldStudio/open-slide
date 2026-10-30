export type CollabPresence = {
  user: string;
  color: string;
  slideId: string | null;
  page: number | null;
  since: number;
  at: number;
  readOnly: boolean;
};

export type Participant = CollabPresence & { connectionId: number };

export type PageLock = { slideId: string; page: number; user: string; color: string };

// A workspace that stopped sending heartbeats (asleep laptop, hung process)
// must not keep a page locked for everyone else.
export const PRESENCE_TTL_MS = 30_000;

export function isFresh(p: CollabPresence, now: number): boolean {
  return now - p.at < PRESENCE_TTL_MS;
}

// Whoever reached a page first holds it until they leave; ties go to the
// lower connection id so every workspace computes the same holder.
export function pageHolders(participants: Participant[], now: number): Map<string, Participant> {
  const holders = new Map<string, Participant>();
  for (const p of participants) {
    if (!isFresh(p, now) || p.slideId === null || p.page === null || p.readOnly) continue;
    const key = `${p.slideId}#${p.page}`;
    const current = holders.get(key);
    if (
      !current ||
      p.since < current.since ||
      (p.since === current.since && p.connectionId < current.connectionId)
    ) {
      holders.set(key, p);
    }
  }
  return holders;
}

export function locksHeldByOthers(
  self: Participant,
  participants: Participant[],
  now: number,
): PageLock[] {
  const locks: PageLock[] = [];
  for (const holder of pageHolders([self, ...participants], now).values()) {
    if (holder.connectionId === self.connectionId) continue;
    locks.push({
      slideId: holder.slideId as string,
      page: holder.page as number,
      user: holder.user,
      color: holder.color,
    });
  }
  return locks;
}

export function lockFor(
  locks: PageLock[],
  target: { slideId: string; pages: number[] | 'all' },
): PageLock | null {
  return (
    locks.find(
      (lock) =>
        lock.slideId === target.slideId &&
        (target.pages === 'all' || target.pages.includes(lock.page)),
    ) ?? null
  );
}
