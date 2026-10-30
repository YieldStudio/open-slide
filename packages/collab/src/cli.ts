#!/usr/bin/env node
import fs from 'node:fs';
import { decide } from './hook.ts';
import { type CollabState, statePath } from './state.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// Claude Code PreToolUse hook: exit code 2 blocks the tool call and shows
// stderr to Claude.
async function hook(): Promise<number> {
  let input: { tool_input?: { file_path?: string; notebook_path?: string }; cwd?: string };
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return 0;
  }
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!file) return 0;
  const decision = decide(file);
  if (decision.allow) return 0;
  process.stderr.write(`${decision.reason}\n`);
  return 2;
}

async function publishTooling(): Promise<number> {
  const file = statePath(process.cwd());
  if (!fs.existsSync(file)) {
    process.stderr.write('Lance pnpm dev dans ce workspace avant de publier.\n');
    return 1;
  }
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as CollabState;
  const res = await fetch(`http://localhost:${state.port}/__collab/publish-tooling`, {
    method: 'POST',
  });
  const body = (await res.json().catch(() => ({}))) as { tooling?: string; error?: string };
  if (!res.ok) {
    process.stderr.write(`${body.error ?? res.status}\n`);
    return 1;
  }
  process.stdout.write(`Version d'outillage publiée : ${body.tooling}\n`);
  return 0;
}

const command = process.argv[2];
const run = command === 'hook' ? hook : command === 'publish-tooling' ? publishTooling : null;
if (!run) {
  process.stderr.write('usage: open-slide-collab <hook|publish-tooling>\n');
  process.exit(1);
}
process.exit(await run());
