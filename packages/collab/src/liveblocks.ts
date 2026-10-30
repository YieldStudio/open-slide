import { createClient } from '@liveblocks/client';
import { LiveblocksYjsProvider } from '@liveblocks/yjs';
import type * as Y from 'yjs';

export type LiveblocksConnectionOptions = {
  roomId: string;
  publicApiKey?: string;
  authEndpoint?: string;
  doc: Y.Doc;
  timeoutMs?: number;
};

export type LiveblocksConnection = {
  synced: boolean;
  leave(): void;
};

export async function connectLiveblocks(
  opts: LiveblocksConnectionOptions,
): Promise<LiveblocksConnection> {
  const auth = opts.authEndpoint
    ? { authEndpoint: opts.authEndpoint }
    : { publicApiKey: opts.publicApiKey ?? '' };
  const client = createClient({
    ...auth,
    polyfills: { WebSocket: globalThis.WebSocket },
  });
  const { room, leave } = client.enterRoom(opts.roomId, { initialPresence: {} });
  const provider = new LiveblocksYjsProvider(room, opts.doc);

  const synced = await new Promise<boolean>((resolve) => {
    if (provider.synced) return resolve(true);
    const timer = setTimeout(() => resolve(false), opts.timeoutMs ?? 15_000);
    provider.on('sync', (isSynced: boolean) => {
      if (!isSynced) return;
      clearTimeout(timer);
      resolve(true);
    });
  });

  return {
    synced,
    leave() {
      provider.destroy();
      leave();
    },
  };
}
