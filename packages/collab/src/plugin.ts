import path from 'node:path';
import { loadEnv, type Plugin } from 'vite';
import * as Y from 'yjs';
import { connectLiveblocks } from './liveblocks.ts';
import { createSlidesSync } from './sync.ts';

export type OpenSlideCollabOptions = {
  roomId: string;
  publicApiKey?: string;
  authEndpoint?: string;
  cwd?: string;
  slidesDir?: string;
};

const PREFIX = '[collab]';

export function openSlideCollab(opts: OpenSlideCollabOptions): Plugin {
  return {
    name: 'open-slide-collab',
    apply: 'serve',
    async configureServer(server) {
      const cwd = opts.cwd ?? process.cwd();
      const root = path.resolve(cwd, opts.slidesDir ?? 'slides');
      const env = loadEnv(server.config.mode, cwd, 'LIVEBLOCKS_');
      const publicApiKey = opts.publicApiKey ?? env.LIVEBLOCKS_PUBLIC_KEY;
      const log = (message: string) => server.config.logger.info(`${PREFIX} ${message}`);
      if (!publicApiKey && !opts.authEndpoint) {
        server.config.logger.warn(
          `${PREFIX} no LIVEBLOCKS_PUBLIC_KEY or authEndpoint; slides are not synced`,
        );
        return;
      }

      const doc = new Y.Doc();
      const connection = await connectLiveblocks({
        roomId: opts.roomId,
        publicApiKey,
        authEndpoint: opts.authEndpoint,
        doc,
      });
      // Seeding or materializing against a room we couldn't read would either
      // upload a stale copy or wipe local work, so stay offline instead.
      if (!connection.synced) {
        server.config.logger.warn(
          `${PREFIX} could not reach room "${opts.roomId}"; slides are not synced`,
        );
        connection.leave();
        return;
      }

      const sync = createSlidesSync({
        root,
        doc,
        backupDir: path.join(cwd, '.collab-backups'),
        log,
      });
      await sync.start();
      log(`syncing ${path.relative(cwd, root) || '.'} with room "${opts.roomId}"`);

      server.watcher.add(root);
      const inRoot = (file: string) => file.startsWith(root + path.sep);
      server.watcher.on('add', (file) => inRoot(file) && void sync.localChanged(file));
      server.watcher.on('change', (file) => inRoot(file) && void sync.localChanged(file));
      server.watcher.on('unlink', (file) => inRoot(file) && sync.localRemoved(file));
      server.httpServer?.once('close', () => {
        sync.stop();
        connection.leave();
      });
    },
  };
}
