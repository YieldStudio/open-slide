import fs from 'node:fs';
import path from 'node:path';
import { lockFor } from './locks.ts';
import { pagesForFile } from './pages.ts';
import { type CollabState, STATE_TTL_MS, statePath } from './state.ts';

export type HookDecision = { allow: true } | { allow: false; reason: string };

// The nearest open-slide workspace above `start`, with its collab state if
// its dev server has written one.
function findWorkspace(start: string): { root: string; state: CollabState | null } | null {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'open-slide.config.ts'))) {
      try {
        return { root: dir, state: JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) };
      } catch {
        return { root: dir, state: null };
      }
    }
    if (path.dirname(dir) === dir) return null;
  }
}

const NOT_RUNNING =
  "Le serveur open-slide (pnpm dev) ne tourne pas : les slides ne sont pas synchronisées et cette modification serait écrasée au prochain démarrage. Demande à l'utilisateur de lancer pnpm dev, puis réessaie.";

// Decides whether Claude Code may write `file`. Files outside a workspace's
// slides/ folder are never our business.
export function decide(file: string, now = Date.now()): HookDecision {
  const abs = path.resolve(file);
  const workspace = findWorkspace(path.dirname(abs));
  if (!workspace) return { allow: true };
  const { state } = workspace;
  const slidesRoot = state?.slidesRoot ?? path.join(workspace.root, 'slides');
  if (!abs.startsWith(slidesRoot + path.sep)) return { allow: true };
  if (!state || now - state.updatedAt > STATE_TTL_MS) return { allow: false, reason: NOT_RUNNING };
  if (state.readOnly) return { allow: false, reason: `Slides en lecture seule : ${state.reason}` };
  const rel = path.relative(slidesRoot, abs).split(path.sep).join('/');
  const target = pagesForFile(slidesRoot, rel);
  const lock = target && lockFor(state.locks, target);
  if (lock) {
    return {
      allow: false,
      reason: `${lock.user} est en train de modifier la page ${lock.page + 1} du deck « ${lock.slideId} » (${rel}). Ne modifie pas ce fichier maintenant : préviens l'utilisateur et attends que la page soit libérée.`,
    };
  }
  return { allow: true };
}
