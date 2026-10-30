import fs from 'node:fs/promises';
import type { ViteDevServer } from 'vite';
import { applyEditBatch, type BatchEdit, type BatchEditResult } from '../../editing/batch-edit.ts';
import { applyEdit, type EditOp } from '../../editing/edit-ops.ts';
import { applyRevertAsset } from '../../editing/revert-asset.ts';
import { validateMutationRequest } from '../../http/request-guard.ts';
import {
  type ApiContext,
  json,
  readBody,
  readSlideSource,
  resolveSlideEntryPath,
  resolveSlideLoc,
  type SlideLoc,
  withFileLock,
} from './context.ts';

// POST /__edit                applyEdit({ slideId, line, column, ops })
// POST /__edit/revert-asset   applyRevertAsset({ slideId, assetPath })
// POST /__edit/batch          applyEdit × N — single FS write per file

type EditBody = {
  slideId?: string;
  line?: number;
  column?: number;
  ops?: EditOp[];
};

type EditBatchBody = {
  slideId?: string;
  edits?: BatchEdit[];
};

export function registerEditRoutes(server: ViteDevServer, ctx: ApiContext): void {
  server.middlewares.use('/__edit', async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const method = req.method ?? 'GET';
    if (method !== 'POST') return next();
    const requestCheck = validateMutationRequest(req, { requireJsonBody: true });
    if (!requestCheck.ok) return json(res, requestCheck.status, { error: requestCheck.error });

    try {
      if (url.pathname === '/') {
        const body = (await readBody(req)) as EditBody;
        const slideId = body.slideId ?? '';
        if (!resolveSlideEntryPath(ctx, slideId))
          return json(res, 400, { error: 'invalid slideId' });
        if (!body.line || body.line < 1) return json(res, 400, { error: 'invalid line' });
        if (!Array.isArray(body.ops)) return json(res, 400, { error: 'missing ops' });
        const loc = resolveSlideLoc(ctx, slideId, body.line);
        if (!loc) return json(res, 409, { error: 'stale element location, reload the page' });
        const ops = body.ops;

        const outcome = await withFileLock(loc.path, async () => {
          const source = await readSlideSource(loc.path);
          if (source === null) return { status: 404, body: { error: 'slide not found' } };
          const result = applyEdit(source, loc.line, body.column ?? 0, ops);
          if (!result.ok) return { status: result.status, body: { error: result.error } };
          const changed = result.source !== source;
          if (changed) await fs.writeFile(loc.path, result.source, 'utf8');
          return { status: 200, body: { ok: true, changed } };
        });
        return json(res, outcome.status, outcome.body);
      }

      if (url.pathname === '/revert-asset') {
        const body = (await readBody(req)) as { slideId?: string; assetPath?: string };
        const slideId = body.slideId ?? '';
        const assetPath = body.assetPath;
        const file = resolveSlideEntryPath(ctx, slideId);
        if (!file) return json(res, 400, { error: 'invalid slideId' });
        if (typeof assetPath !== 'string' || !assetPath) {
          return json(res, 400, { error: 'missing assetPath' });
        }
        if (!assetPath.startsWith('./assets/') && !assetPath.startsWith('@assets/')) {
          return json(res, 400, { error: 'asset path must start with ./assets/ or @assets/' });
        }

        const outcome = await withFileLock(file, async () => {
          const source = await readSlideSource(file);
          if (source === null) return { status: 404, body: { error: 'slide not found' } };
          const result = applyRevertAsset(source, assetPath);
          if (!result.ok) return { status: result.status, body: { error: result.error } };
          const changed = result.source !== source;
          if (changed) await fs.writeFile(file, result.source, 'utf8');
          return { status: 200, body: { ok: true, changed } };
        });
        return json(res, outcome.status, outcome.body);
      }

      // One read-modify-write per file so a multi-element edit session
      // lands as a single HMR per file. Per-edit failures are reported but
      // don't abort the batch.
      if (url.pathname === '/batch') {
        const body = (await readBody(req)) as EditBatchBody;
        const slideId = body.slideId ?? '';
        if (!resolveSlideEntryPath(ctx, slideId))
          return json(res, 400, { error: 'invalid slideId' });
        if (!Array.isArray(body.edits)) return json(res, 400, { error: 'missing edits' });

        const results: BatchEditResult[] = body.edits.map((edit) => ({
          ok: false,
          error:
            typeof edit?.line === 'number' && edit.line >= 1
              ? 'stale element location, reload the page'
              : 'invalid edit',
        }));
        const groups = groupEditsByFile(ctx, slideId, body.edits);
        let changed = false;
        for (const group of groups.values()) {
          await withFileLock(group.loc.path, async () => {
            const source = await readSlideSource(group.loc.path);
            if (source === null) {
              for (const index of group.indices)
                results[index] = { ok: false, error: 'file not found' };
              return;
            }
            const batch = applyEditBatch(source, group.edits);
            batch.results.forEach((result, i) => {
              results[group.indices[i]] = result;
            });
            if (batch.source !== source) {
              await fs.writeFile(group.loc.path, batch.source, 'utf8');
              changed = true;
            }
          });
        }
        return json(res, 200, { ok: true, changed, results });
      }

      return next();
    } catch (err) {
      json(res, 500, { error: String((err as Error).message ?? err) });
    }
  });
}

type EditGroup = { loc: SlideLoc; edits: BatchEdit[]; indices: number[] };

// `dependsOn` points into the request's edit list. Rewrite it to point into
// the file's own sub-batch; a dependency on an edit in another file can't be
// honoured, so it is left out of range and the edit is rejected as invalid.
function groupEditsByFile(
  ctx: ApiContext,
  slideId: string,
  edits: BatchEdit[],
): Map<string, EditGroup> {
  const groups = new Map<string, EditGroup>();
  const placement = new Map<number, { path: string; index: number }>();
  edits.forEach((edit, index) => {
    const loc = typeof edit?.line === 'number' ? resolveSlideLoc(ctx, slideId, edit.line) : null;
    if (!loc) return;
    let group = groups.get(loc.path);
    if (!group) {
      group = { loc, edits: [], indices: [] };
      groups.set(loc.path, group);
    }
    const dependency = edit.dependsOn === undefined ? undefined : placement.get(edit.dependsOn);
    const dependsOn =
      edit.dependsOn === undefined
        ? undefined
        : dependency?.path === loc.path
          ? dependency.index
          : Number.MAX_SAFE_INTEGER;
    placement.set(index, { path: loc.path, index: group.edits.length });
    group.edits.push({ ...edit, line: loc.line, dependsOn });
    group.indices.push(index);
  });
  return groups;
}
