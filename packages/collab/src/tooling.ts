import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Everything outside slides/ that changes how a deck renders or how agents
// edit it. Two workspaces that disagree on any of it must not both write.
export const DEFAULT_TOOLING_PATHS = [
  'themes',
  'assets',
  'open-slide.config.ts',
  'package.json',
  'pnpm-lock.yaml',
  'bun.lock',
  'package-lock.json',
  'yarn.lock',
  '.claude/skills',
  '.claude/settings.json',
];

async function collect(abs: string, rel: string, out: string[]): Promise<void> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(abs);
  } catch {
    return;
  }
  if (stat.isFile()) {
    out.push(rel);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const name of (await fs.readdir(abs)).sort()) {
    if (name.startsWith('.') && name !== '.claude') continue;
    if (name === 'node_modules') continue;
    await collect(path.join(abs, name), `${rel}/${name}`, out);
  }
}

export async function toolingFingerprint(
  cwd: string,
  paths: string[] = DEFAULT_TOOLING_PATHS,
): Promise<string> {
  const files: string[] = [];
  for (const rel of paths) await collect(path.join(cwd, rel), rel, files);
  const hash = createHash('sha256');
  for (const rel of files.sort()) {
    hash.update(rel);
    hash.update('\0');
    hash.update(await fs.readFile(path.join(cwd, rel)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
