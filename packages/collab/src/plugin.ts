import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadEnv, type Plugin, type ViteDevServer, type WebSocketClient } from 'vite';
import * as Y from 'yjs';
import { CLIENT_SOURCE } from './client.ts';
import { connectLiveblocks, type LiveblocksConnection } from './liveblocks.ts';
import {
  type CollabPresence,
  isFresh,
  locksHeldByOthers,
  type PageLock,
  type Participant,
} from './locks.ts';
import { type CollabState, statePath } from './state.ts';
import { createSlidesSync } from './sync.ts';
import { toolingFingerprint } from './tooling.ts';

export type OpenSlideCollabOptions = {
  roomId: string;
  publicApiKey?: string;
  authEndpoint?: string;
  user?: string;
  cwd?: string;
  slidesDir?: string;
  toolingPaths?: string[];
};

const PREFIX = '[collab]';
const CLIENT_ID = 'virtual:open-slide-collab/client';
const RESOLVED_CLIENT_ID = `\0${CLIENT_ID}`;
const HEARTBEAT_MS = 5_000;
// A tab that stopped reporting (closed, crashed) frees its page quickly.
const CLIENT_TTL_MS = 6_000;

const MUTATING_ROUTES = [
  '/__edit',
  '/__comments',
  '/__notes',
  '/__slides',
  '/__assets',
  '/__folders',
  '/__design',
  '/__agent/sessions',
];
const PAGE_SCOPED_ROUTES = ['/__edit', '/__comments', '/__notes'];

function resolveUser(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.COLLAB_USER) return process.env.COLLAB_USER;
  try {
    const name = execSync('git config user.name', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    if (name) return name;
  } catch {}
  return os.userInfo().username;
}

function colorFor(user: string): string {
  const hue = Number.parseInt(createHash('sha1').update(user).digest('hex').slice(0, 4), 16) % 360;
  return `hsl(${hue} 70% 45%)`;
}

function locationFromUrl(pathname: string, search: string) {
  const match = /^\/s\/([^/]+)/.exec(pathname);
  if (!match) return null;
  const page = Number(new URLSearchParams(search).get('p') ?? '1') - 1;
  return {
    slideId: decodeURIComponent(match[1]),
    page: Number.isInteger(page) && page >= 0 ? page : 0,
  };
}

function deny(res: ServerResponse, message: string) {
  res.statusCode = 423;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: message }));
}

export function openSlideCollab(opts: OpenSlideCollabOptions): Plugin {
  let base = '/';
  return {
    name: 'open-slide-collab',
    apply: 'serve',
    // Our guard middleware must run before open-slide's own write routes.
    enforce: 'pre',
    configResolved(config) {
      base = config.base;
    },
    resolveId(id) {
      return id === CLIENT_ID ? RESOLVED_CLIENT_ID : null;
    },
    load(id) {
      return id === RESOLVED_CLIENT_ID ? CLIENT_SOURCE : null;
    },
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: `${base}@id/${CLIENT_ID}` },
          injectTo: 'body',
        },
      ];
    },
    async configureServer(server) {
      await startCollab(server, opts);
    },
  };
}

async function startCollab(server: ViteDevServer, opts: OpenSlideCollabOptions): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const slidesRoot = path.resolve(cwd, opts.slidesDir ?? 'slides');
  const logger = server.config.logger;
  const log = (message: string) => logger.info(`${PREFIX} ${message}`);
  const env = loadEnv(server.config.mode, cwd, 'LIVEBLOCKS_');
  const publicApiKey = opts.publicApiKey ?? env.LIVEBLOCKS_PUBLIC_KEY;
  const user = resolveUser(opts.user);
  const color = colorFor(user);
  const tooling = await toolingFingerprint(cwd, opts.toolingPaths);

  let connection: LiveblocksConnection | null = null;
  let roomTooling: string | null = null;
  const clients = new Map<
    WebSocketClient,
    { slideId: string; page: number; changedAt: number; aliveAt: number }
  >();
  let here: { slideId: string; page: number } | null = null;
  let since = Date.now();
  let lastBroadcast = '';
  let port = 0;
  let state: CollabState = {
    user,
    color,
    online: false,
    readOnly: true,
    reason: 'Connexion à la room en cours…',
    here: null,
    blockedBy: null,
    locks: [],
    participants: [],
    slidesRoot,
    port: 0,
    updatedAt: Date.now(),
  };

  server.middlewares.use((req, res, next) => {
    const method = req.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD') return next();
    const url = req.url ?? '';
    if (url.startsWith('/__collab/publish-tooling')) {
      if (!connection) return deny(res, 'Pas connecté à la room.');
      doc.getMap('meta').set('tooling', tooling);
      log(`published tooling version ${tooling}`);
      refresh();
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ok: true, tooling }));
    }
    const route = MUTATING_ROUTES.find((prefix) => url.startsWith(prefix));
    if (!route) return next();
    if (state.readOnly) return deny(res, `Lecture seule : ${state.reason}`);
    if (PAGE_SCOPED_ROUTES.includes(route) && state.blockedBy) {
      return deny(res, `${state.blockedBy.user} modifie cette page.`);
    }
    next();
  });

  const doc = new Y.Doc();

  function participants(now: number): Participant[] {
    return connection ? connection.others().filter((p) => isFresh(p, now)) : [];
  }

  function self(now: number): Participant {
    return {
      user,
      color,
      slideId: here?.slideId ?? null,
      page: here?.page ?? null,
      since,
      at: now,
      readOnly: state.readOnly,
      connectionId: connection?.connectionId() ?? -1,
    };
  }

  function computeHere(now: number) {
    let latest: { slideId: string; page: number; changedAt: number } | null = null;
    for (const [client, info] of clients) {
      if (now - info.aliveAt > CLIENT_TTL_MS) {
        clients.delete(client);
        continue;
      }
      if (!latest || info.changedAt > latest.changedAt) latest = info;
    }
    const next = latest ? { slideId: latest.slideId, page: latest.page } : null;
    if (next?.slideId !== here?.slideId || next?.page !== here?.page) {
      here = next;
      since = now;
    }
  }

  function refresh() {
    const now = Date.now();
    computeHere(now);
    const readOnlyReason = !connection
      ? 'hors ligne : la room Liveblocks est injoignable, relance pnpm dev une fois en ligne.'
      : roomTooling !== null && roomTooling !== tooling
        ? `outillage pas à jour (local ${tooling}, room ${roomTooling}). Fais git pull puis pnpm install et relance pnpm dev — ou, si c'est toi qui as changé l'outillage, publie-le avec « open-slide-collab publish-tooling ».`
        : null;
    const readOnly = readOnlyReason !== null;
    const me = self(now);
    me.readOnly = readOnly;
    const others = participants(now);
    const locks: PageLock[] = connection ? locksHeldByOthers(me, others, now) : [];
    const blockedBy =
      here === null
        ? null
        : (locks.find((l) => l.slideId === here?.slideId && l.page === here?.page) ?? null);
    state = {
      user,
      color,
      online: connection !== null,
      readOnly,
      reason: readOnlyReason,
      here,
      blockedBy,
      locks,
      participants: others.map(({ user, color, slideId, page }) => ({
        user,
        color,
        slideId,
        page,
      })),
      slidesRoot,
      port,
      updatedAt: now,
    };
    connection?.updatePresence({
      slideId: me.slideId,
      page: me.page,
      since,
      at: now,
      readOnly,
    } satisfies Partial<CollabPresence>);
    const visible = JSON.stringify({ ...state, updatedAt: 0 });
    if (visible !== lastBroadcast) {
      lastBroadcast = visible;
      server.ws.send({ type: 'custom', event: 'collab:state', data: state });
    }
    void writeState(cwd, state);
  }

  server.ws.on('collab:hello', (_data, client) => {
    client.send('collab:state', state);
  });
  server.ws.on('collab:location', (data: { path?: string; search?: string }, client) => {
    const now = Date.now();
    const location = locationFromUrl(data.path ?? '', data.search ?? '');
    if (!location) clients.delete(client);
    else {
      const previous = clients.get(client);
      const moved = previous?.slideId !== location.slideId || previous?.page !== location.page;
      clients.set(client, {
        ...location,
        changedAt: moved ? now : (previous?.changedAt ?? now),
        aliveAt: now,
      });
    }
    refresh();
  });
  server.ws.on('collab:alive', (_data, client) => {
    const info = clients.get(client);
    if (info) info.aliveAt = Date.now();
  });

  const heartbeat = setInterval(refresh, HEARTBEAT_MS);
  server.httpServer?.once('close', () => {
    clearInterval(heartbeat);
    connection?.leave();
    void fs.rm(statePath(cwd), { force: true });
  });

  server.httpServer?.once('listening', () => {
    const address = server.httpServer?.address();
    if (address && typeof address === 'object') port = address.port;
    refresh();
  });
  refresh();

  if (!publicApiKey && !opts.authEndpoint) {
    logger.warn(`${PREFIX} no LIVEBLOCKS_PUBLIC_KEY or authEndpoint; slides are not synced`);
    return;
  }

  const attempt = await connectLiveblocks({
    roomId: opts.roomId,
    publicApiKey,
    authEndpoint: opts.authEndpoint,
    doc,
    presence: { ...self(Date.now()), readOnly: true },
  });
  // Seeding or materializing against a room we couldn't read would either
  // upload a stale copy or wipe local work, so stay read-only instead.
  if (!attempt.synced) {
    logger.warn(
      `${PREFIX} could not reach room "${opts.roomId}"; read-only until restarted online`,
    );
    attempt.leave();
    refresh();
    return;
  }
  connection = attempt;

  const meta = doc.getMap<string>('meta');
  if (!meta.has('tooling')) meta.set('tooling', tooling);
  roomTooling = meta.get('tooling') ?? null;
  meta.observe(() => {
    roomTooling = meta.get('tooling') ?? null;
    refresh();
  });
  connection.onOthersChange(refresh);

  const sync = createSlidesSync({
    root: slidesRoot,
    doc,
    backupDir: path.join(cwd, '.collab-backups'),
    log,
    canUpload: () => !state.readOnly,
  });
  await sync.start();
  log(`syncing ${path.relative(cwd, slidesRoot) || '.'} with room "${opts.roomId}" as ${user}`);
  refresh();

  server.watcher.add(slidesRoot);
  const inRoot = (file: string) => file.startsWith(slidesRoot + path.sep);
  server.watcher.on('add', (file) => inRoot(file) && void sync.localChanged(file));
  server.watcher.on('change', (file) => inRoot(file) && void sync.localChanged(file));
  server.watcher.on('unlink', (file) => inRoot(file) && sync.localRemoved(file));
  server.httpServer?.once('close', () => sync.stop());
}

async function writeState(cwd: string, state: CollabState): Promise<void> {
  const file = statePath(cwd);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(state, null, 2));
    await fs.rename(`${file}.tmp`, file);
  } catch {}
}
