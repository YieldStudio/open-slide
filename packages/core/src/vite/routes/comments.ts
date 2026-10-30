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
  json,
  readBody,
  readSlideSource,
  resolveSlideEntryPath,
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
        const file = resolveSlideEntryPath(ctx, slideId);
        if (!file) return json(res, 400, { error: 'invalid slideId' });
        const source = await readSlideSource(file);
        if (source === null) return json(res, 404, { error: 'slide not found' });
        return json(res, 200, { comments: resolveTargets(source, parseMarkers(source)) });
      }

      if (method === 'POST' && url.pathname === '/add') {
        const requestCheck = validateMutationRequest(req, { requireJsonBody: true });
        if (!requestCheck.ok) {
          return json(res, requestCheck.status, { error: requestCheck.error });
        }
        const body = (await readBody(req)) as AddCommentBody;
        const slideId = body.slideId ?? '';
        const file = resolveSlideEntryPath(ctx, slideId);
        if (!file) return json(res, 400, { error: 'invalid slideId' });
        if (!body.line || body.line < 1) return json(res, 400, { error: 'invalid line' });
        if (!body.text || typeof body.text !== 'string') {
          return json(res, 400, { error: 'missing text' });
        }

        const text = body.text;
        const outcome = await withFileLock(file, async () => {
          const source = await readSlideSource(file);
          if (source === null) return { status: 404, body: { error: 'slide not found' } };

          const plan = findInsertion(source, body.line ?? 0, body.column);
          if (!plan) {
            return {
              status: 422,
              body: {
                error:
                  'could not find a JSX container around line ' +
                  `${body.line}. Try clicking a different element.`,
              },
            };
          }

          const id = newCommentId();
          const ts = new Date().toISOString();
          const payload: CommentPayload = {
            note: text,
            hint: body.hint,
            rect: parseCommentRect(body.rect),
            page: parseCommentPage(body.page),
          };
          const encoded = b64urlEncode(JSON.stringify(payload));
          const marker = buildMarker(plan, id, ts, encoded);

          const next = source.slice(0, plan.offset) + marker + source.slice(plan.offset);
          await fs.writeFile(file, next, 'utf8');
          return { status: 200, body: { id, line: offsetToLine(next, plan.offset + 1) } };
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
        const file = resolveSlideEntryPath(ctx, body.slideId ?? '');
        if (!file) return json(res, 400, { error: 'invalid slideId' });
        if (!body.text || typeof body.text !== 'string') {
          return json(res, 400, { error: 'missing text' });
        }
        const text = body.text;
        const outcome = await withFileLock(file, () =>
          rewriteMarker(file, (source) => updateMarkerNote(source, id, text)),
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
        const file = resolveSlideEntryPath(ctx, slideId);
        if (!file) return json(res, 400, { error: 'invalid slideId' });

        const outcome = await withFileLock(file, () =>
          rewriteMarker(file, (source) => removeMarker(source, id)),
        );
        return json(res, outcome.status, outcome.body);
      }

      next();
    } catch (err) {
      json(res, 500, { error: String((err as Error).message ?? err) });
    }
  });
}

async function rewriteMarker(
  file: string,
  rewrite: (source: string) => string | null,
): Promise<{ status: number; body: unknown }> {
  const source = await readSlideSource(file);
  if (source === null) return { status: 404, body: { error: 'slide not found' } };
  const next = rewrite(source);
  if (next === null) return { status: 404, body: { error: 'marker not found' } };
  await fs.writeFile(file, next, 'utf8');
  return { status: 200, body: { ok: true } };
}
