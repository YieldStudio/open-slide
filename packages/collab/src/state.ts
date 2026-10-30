import path from 'node:path';
import type { PageLock } from './locks.ts';

export type CollabState = {
  user: string;
  color: string;
  online: boolean;
  readOnly: boolean;
  reason: string | null;
  here: { slideId: string; page: number } | null;
  blockedBy: PageLock | null;
  locks: PageLock[];
  participants: { user: string; color: string; slideId: string | null; page: number | null }[];
  slidesRoot: string;
  port: number;
  updatedAt: number;
};

// Refreshed every few seconds while the dev server runs; the Claude Code hook
// treats an old file as "server not running".
export const STATE_TTL_MS = 20_000;

export function statePath(cwd: string): string {
  return path.join(cwd, 'node_modules', '.open-slide', 'collab.json');
}
