import fs from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import type { Connect } from 'vite';
import { createLocSpace, type LocSpace } from '../../editing/loc-space.ts';
import { resolveSlideEntry } from '../../editing/slide-ops.ts';
import { foldersManifestPath } from '../../files/folders.ts';

export type ApiContext = {
  userCwd: string;
  slidesDir: string;
  slidesRoot: string;
  globalAssetsRoot: string;
  manifestPath: string;
  coreVersion: string;
  agentEnabled: boolean;
  locSpace: LocSpace;
};

export type ApiPluginOptions = {
  userCwd: string;
  slidesDir?: string;
  assetsDir?: string;
  coreVersion: string;
  agentEnabled: boolean;
  locSpace?: LocSpace;
};

export function makeContext(opts: ApiPluginOptions): ApiContext {
  const userCwd = opts.userCwd;
  const slidesDir = opts.slidesDir ?? 'slides';
  const assetsDir = opts.assetsDir ?? 'assets';
  const slidesRoot = path.resolve(userCwd, slidesDir);
  const globalAssetsRoot = path.resolve(userCwd, assetsDir);
  const manifestPath = foldersManifestPath(slidesRoot);
  return {
    userCwd,
    slidesDir,
    slidesRoot,
    globalAssetsRoot,
    manifestPath,
    coreVersion: opts.coreVersion,
    agentEnabled: opts.agentEnabled,
    locSpace: opts.locSpace ?? createLocSpace(),
  };
}

export class BodyTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'BodyTooLargeError';
  }
}

export async function readBody(
  req: Connect.IncomingMessage,
  limit = Number.POSITIVE_INFINITY,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export function resolveSlideEntryPath(ctx: ApiContext, slideId: string): string | null {
  return resolveSlideEntry(ctx.slidesRoot, slideId);
}

export async function readSlideSource(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function resolveDeckFile(ctx: ApiContext, slideId: string, file: string): string | null {
  const entry = resolveSlideEntryPath(ctx, slideId);
  if (!entry) return null;
  const dir = path.dirname(entry);
  const abs = path.resolve(dir, file);
  if (!abs.startsWith(dir + path.sep) || !abs.endsWith('.tsx')) return null;
  return abs;
}

export type SlideLoc = { file: string; path: string; line: number };

export function resolveSlideLoc(ctx: ApiContext, slideId: string, line: number): SlideLoc | null {
  const loc = ctx.locSpace.decode(slideId, line);
  if (!loc) return null;
  const abs = resolveDeckFile(ctx, slideId, loc.file);
  return abs ? { file: loc.file, path: abs, line: loc.line } : null;
}

export function deckSourceFiles(
  ctx: ApiContext,
  slideId: string,
): { file: string; path: string }[] {
  return ctx.locSpace.files(slideId).flatMap((file) => {
    const abs = resolveDeckFile(ctx, slideId, file);
    return abs ? [{ file, path: abs }] : [];
  });
}

const fileLocks = new Map<string, Promise<unknown>>();

// Each mutation route reads a source file, rewrites it, and writes it back.
// Two clients saving at once would otherwise both read the old text and
// the second write would silently drop the first one's change.
export function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(file) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.catch(() => undefined);
  fileLocks.set(file, settled);
  void settled.then(() => {
    if (fileLocks.get(file) === settled) fileLocks.delete(file);
  });
  return run;
}

export function locateSelection<T extends { line: number }>(
  ctx: ApiContext,
  slideId: string,
  selection: T,
): (T & { file: string }) | null {
  const loc = ctx.locSpace.decode(slideId, selection.line);
  if (!loc) return null;
  const file = path.posix.join(ctx.slidesDir.split(path.sep).join('/'), slideId, loc.file);
  return { ...selection, line: loc.line, file };
}
