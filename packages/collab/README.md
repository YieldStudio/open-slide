# @yieldstudio/open-slide-collab

Live collaboration between local open-slide workspaces. Each person runs their
own `pnpm dev`; the `slides/` folder is kept in sync through a Liveblocks room.

- **Live sync of `slides/`**: edits from the inspector, Claude Code or any
  editor reach the other workspaces in well under a second. Concurrent edits to
  one file are merged (Yjs).
- **Presence**: avatars of who is connected and on which page.
- **Page locks**: the first person on a page holds it while their tab shows it.
  Others see « 🔒 X modifie cette page » and their writes are refused by their
  own dev server. Closing the tab frees the page within seconds.
- **Tooling version gate**: everything outside `slides/` (themes, assets,
  config, lockfile, `.claude/`) travels through git. If a workspace's tooling
  differs from the version published in the room, it turns read-only until it
  pulls and restarts.
- **Offline safety**: a workspace that can't reach the room stays read-only and
  never touches its files.

## Setup

```ts
// open-slide.config.ts
import type { OpenSlideConfig } from '@open-slide/core';
import { openSlideCollab } from '@yieldstudio/open-slide-collab';

const config: OpenSlideConfig = {
  editor: { autosave: true },
  vitePlugins: [openSlideCollab({ roomId: 'yield-slides' })],
};

export default config;
```

```sh
# .env (not committed)
LIVEBLOCKS_PUBLIC_KEY=pk_...
```

```gitignore
slides/
.collab-backups/
.env
```

Your name comes from `COLLAB_USER`, else `git config user.name`.

On start, the room wins: local files that differ from it are copied to
`.collab-backups/<date>/` before being replaced. An empty room is seeded from the
first workspace that joins.

## Claude Code

Block Claude from writing a page someone else holds, or while the workspace is
read-only or its dev server is stopped:

```json
// .claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/node_modules/@yieldstudio/open-slide-collab/dist/cli.js hook"
          }
        ]
      }
    ]
  }
}
```

## Changing tooling

After committing a change to themes, config or dependencies, publish it so
everyone else is asked to pull:

```sh
node node_modules/@yieldstudio/open-slide-collab/dist/cli.js publish-tooling
```

## Limits

- Undo (Cmd+Z) only reaches edits that autosave hasn't written yet (~600 ms).
- Text being typed reaches others when the text editor closes.
- Files shared by several pages (layout components) are not locked; concurrent
  edits there are merged.
- Binary files over 8 MB are not synced.
- `publicApiKey` is for trying it out. For a team, use `authEndpoint` with a
  small server that issues room tokens; never ship the secret key.
