import fs from 'node:fs/promises';
import type { ViteDevServer } from 'vite';
import {
  b64urlEncode,
  buildMarker,
  type CommentPayload,
  findInsertion,
  newCommentId,
  offsetToLine,
  parseCommentPage,
  parseCommentRect,
  parseMarkers,
  removeMarker,
  resolveTargets,
  updateMarkerNote,
} from '../../editing/comments.ts';
import { validateMutationRequest } from '../../http/request-guard.ts';
import {
  type ApiContext,
  deckSourceFiles,
  json,
  readBody,
  readSlideSource,
  resolveSlideEntryPath,
  resolveSlideLoc,
  withFileLock,
} from './context.ts';

// GET    /__comments        list markers for ?slideId=…
// POST   /__comments/add    add marker { slideId, line, column?, text, hint?, rect?, page? }
// PUT    /__comments/:id    replace note { slideId, text }
// DELETE /__comments/:id    remove marker

type AddCommentBody = {
  slideId?: string;
  line?: number;
  column?: number;
  text?: string;
  hint?: string;
  rect?: unknown;
  page?: unknown;
};

export function registerCommentRoutes(server: ViteDevServer, ctx: ApiContext): void {
  server.middlewares.use('/__comments', async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET' && url.pathname === '/') {
        const slideId = url.searchParams.get('slideId') ?? '';
        const entry = resolveSlideEntryPath(ctx, slideId);
        if (!entry) return json(res, 400, { error: 'invalid slideId' });
        if ((await readSlideSource(entry)) === null) {
          return json(res, 404, { error: 'slide not found' });
        }
        const comments = [];
        for (const { file, path } of deckSourceFiles(ctx, slideId)) {
          const source = await readSlideSource(path);
          if (source === null) continue;
          const encode = (line: number) => ctx.locSpace.encode(slideId, file, line);
          for (const comment of resolveTargets(source, parseMarkers(source))) {
            comments.push({
              ...comment,
              line: encode(comment.line),
              target: comment.target
                ? { line: encode(comment.target.line), column: comment.target.column }
                : comment.target,
            });
          }
        }
        return json(res, 200, { comments });
      }

      if (method === 'POST' && url.pathname === '/add') {
        const requestCheck = validateMutationRequest(req, { requireJsonBody: true });
        if (!requestCheck.ok) {
          return json(res, requestCheck.status, { error: requestCheck.error });
        }
        const body = (await readBody(req)) as AddCommentBody;
        const slideId = body.slideId ?? '';
        if (!resolveSlideEntryPath(ctx, slideId))
          return json(res, 400, { error: 'invalid slideId' });
        if (!body.line || body.line < 1) return json(res, 400, { error: 'invalid line' });
        if (!body.text || typeof body.text !== 'string') {
          return json(res, 400, { error: 'missing text' });
        }
        const loc = resolveSlideLoc(ctx, slideId, body.line);
        if (!loc) return json(res, 409, { error: 'stale element location, reload the page' });
        const payload: CommentPayload = {
          note: body.text,
          hint: body.hint,
          rect: parseCommentRect(body.rect),
          page: parseCommentPage(body.page),
        };

        const outcome = await withFileLock(loc.path, async () => {
          const source = await readSlideSource(loc.path);
          if (source === null) return { status: 404, body: { error: 'slide not found' } };

          const plan = findInsertion(source, loc.line, body.column);
          if (!plan) {
            return {
              status: 422,
              body: {
                error:
                  'could not find a JSX container around line ' +
                  `${loc.line}. Try clicking a different element.`,
              },
            };
          }

          const id = newCommentId();
          const ts = new Date().toISOString();
          const encoded = b64urlEncode(JSON.stringify(payload));
          const marker = buildMarker(plan, id, ts, encoded);

          const next = source.slice(0, plan.offset) + marker + source.slice(plan.offset);
          await fs.writeFile(loc.path, next, 'utf8');
          const markerLine = offsetToLine(next, plan.offset + 1);
          return {
            status: 200,
            body: { id, line: ctx.locSpace.encode(slideId, loc.file, markerLine) },
          };
        });
        return json(res, outcome.status, outcome.body);
      }

      if (method === 'PUT' && url.pathname.startsWith('/')) {
        const requestCheck = validateMutationRequest(req, { requireJsonBody: true });
        if (!requestCheck.ok) {
          return json(res, requestCheck.status, { error: requestCheck.error });
        }
        const id = url.pathname.slice(1);
        if (!/^c-[a-f0-9]+$/.test(id)) return json(res, 400, { error: 'invalid id' });
        const body = (await readBody(req)) as { slideId?: string; text?: string };
        const slideId = body.slideId ?? '';
        if (!resolveSlideEntryPath(ctx, slideId))
          return json(res, 400, { error: 'invalid slideId' });
        if (!body.text || typeof body.text !== 'string') {
          return json(res, 400, { error: 'missing text' });
        }
        const text = body.text;
        const outcome = await rewriteMarker(ctx, slideId, (source) =>
          updateMarkerNote(source, id, text),
        );
        return json(res, outcome.status, outcome.body);
      }

      if (method === 'DELETE' && url.pathname.startsWith('/')) {
        const requestCheck = validateMutationRequest(req);
        if (!requestCheck.ok) {
          return json(res, requestCheck.status, { error: requestCheck.error });
        }
        const id = url.pathname.slice(1);
        if (!/^c-[a-f0-9]+$/.test(id)) return json(res, 400, { error: 'invalid id' });
        const slideId = url.searchParams.get('slideId') ?? '';
        if (!resolveSlideEntryPath(ctx, slideId))
          return json(res, 400, { error: 'invalid slideId' });
        const outcome = await rewriteMarker(ctx, slideId, (source) => removeMarker(source, id));
        return json(res, outcome.status, outcome.body);
      }

      next();
    } catch (err) {
      json(res, 500, { error: String((err as Error).message ?? err) });
    }
  });
}

// Markers live in whichever deck file holds the commented element, so an id
// alone doesn't say which file to rewrite.
async function rewriteMarker(
  ctx: ApiContext,
  slideId: string,
  rewrite: (source: string) => string | null,
): Promise<{ status: number; body: unknown }> {
  let foundSlide = false;
  for (const { path } of deckSourceFiles(ctx, slideId)) {
    const done = await withFileLock(path, async () => {
      const source = await readSlideSource(path);
      if (source === null) return false;
      foundSlide = true;
      const next = rewrite(source);
      if (next === null) return false;
      await fs.writeFile(path, next, 'utf8');
      return true;
    });
    if (done) return { status: 200, body: { ok: true } };
  }
  return foundSlide
    ? { status: 404, body: { error: 'marker not found' } }
    : { status: 404, body: { error: 'slide not found' } };
}
