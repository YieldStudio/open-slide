import { createClient } from '@liveblocks/client';
import { LiveblocksYjsProvider } from '@liveblocks/yjs';
import type * as Y from 'yjs';
import type { CollabPresence, Participant } from './locks.ts';

export type LiveblocksConnectionOptions = {
  roomId: string;
  publicApiKey?: string;
  authEndpoint?: string;
  doc: Y.Doc;
  presence: CollabPresence;
  timeoutMs?: number;
};

export type LiveblocksConnection = {
  synced: boolean;
  connectionId(): number;
  others(): Participant[];
  updatePresence(patch: Partial<CollabPresence>): void;
  onOthersChange(listener: () => void): void;
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
  const { room, leave } = client.enterRoom(opts.roomId, {
    initialPresence: opts.presence as unknown as Record<string, never>,
  });
  const provider = new LiveblocksYjsProvider(room, opts.doc);

  const synced = await new Promise<boolean>((resolve) => {
    if (provider.synced) return resolve(true);
    const timer = setTimeout(() => done(false), opts.timeoutMs ?? 15_000);
    // A refused key or room access fails right away instead of after the timeout.
    const offError = room.subscribe('error', () => done(false));
    function done(ok: boolean) {
      clearTimeout(timer);
      offError();
      resolve(ok);
    }
    provider.on('sync', (isSynced: boolean) => {
      if (isSynced) done(true);
    });
  });

  const unsubscribers: (() => void)[] = [];
  return {
    synced,
    connectionId: () => room.getSelf()?.connectionId ?? -1,
    others: () =>
      room.getOthers().map((other) => ({
        ...(other.presence as unknown as CollabPresence),
        connectionId: other.connectionId,
      })),
    updatePresence: (patch) => room.updatePresence(patch as unknown as Record<string, never>),
    onOthersChange(listener) {
      unsubscribers.push(room.subscribe('others', listener));
    },
    leave() {
      for (const unsubscribe of unsubscribers) unsubscribe();
      provider.destroy();
      leave();
    },
  };
}
