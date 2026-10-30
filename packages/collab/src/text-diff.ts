import type * as Y from 'yjs';

// Turns a whole-file rewrite into the smallest single splice, so a
// collaborator's concurrent edit elsewhere in the same file survives the merge.
export function applyTextChange(text: Y.Text, next: string): void {
  const prev = text.toString();
  if (prev === next) return;
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  let prevEnd = prev.length;
  let nextEnd = next.length;
  while (
    prevEnd > start &&
    nextEnd > start &&
    prev.charCodeAt(prevEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    prevEnd--;
    nextEnd--;
  }
  if (prevEnd > start) text.delete(start, prevEnd - start);
  if (nextEnd > start) text.insert(start, next.slice(start, nextEnd));
}
