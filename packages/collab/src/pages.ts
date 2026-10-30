import fs from 'node:fs';
import path from 'node:path';

const IMPORT_RE = /import\s+(\w+)\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/g;
const DEFAULT_EXPORT_RE = /export\s+default\s*\[([\s\S]*?)\]\s*;?\s*(?:$|export\s)/;

function normalize(rel: string): string {
  return path.posix.normalize(rel).replace(/\.(tsx|ts|jsx|js)$/, '');
}

// Which pages of a deck a file renders, read from the deck's `index.tsx`:
// `export default [Intro, Market]` plus the matching default imports. The
// entry itself, or a deck that can't be read this way, counts as every page.
export function pagesForFile(
  slidesRoot: string,
  rel: string,
): { slideId: string; pages: number[] | 'all' } | null {
  const [slideId, ...rest] = rel.split('/');
  if (!slideId || rest.length === 0) return null;
  const inDeck = rest.join('/');
  if (/^index\.(tsx|ts|jsx|js)$/.test(inDeck)) return { slideId, pages: 'all' };

  let source: string;
  try {
    source = fs.readFileSync(path.join(slidesRoot, slideId, 'index.tsx'), 'utf8');
  } catch {
    return null;
  }
  const list = DEFAULT_EXPORT_RE.exec(source)?.[1];
  if (!list) return { slideId, pages: 'all' };
  const imports = new Map<string, string>();
  for (const match of source.matchAll(IMPORT_RE)) imports.set(match[1], normalize(match[2]));
  const target = normalize(`./${inDeck}`);
  const pages: number[] = [];
  list
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item, index) => {
      if (imports.get(item) === target) pages.push(index);
    });
  return pages.length ? { slideId, pages } : null;
}
