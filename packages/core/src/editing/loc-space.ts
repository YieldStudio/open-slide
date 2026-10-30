// A deck can split its pages across files under `slides/<id>/`. Elements
// from a file other than the entry get their loc line shifted into a
// per-file band, so a `line:column` pair stays unique across the whole deck
// and the inspector never has to carry a file path. The entry keeps band 0,
// which leaves single-file decks byte-for-byte unchanged.
export const LOC_FILE_STRIDE = 1_000_000;

export const DECK_ENTRY_FILE = 'index.tsx';

export type DeckLoc = { file: string; line: number };

export type LocSpace = {
  encode(slideId: string, file: string, line: number): number;
  decode(slideId: string, line: number): DeckLoc | null;
  files(slideId: string): string[];
};

export function sourceLine(line: number): number {
  return line % LOC_FILE_STRIDE;
}

// Bands are handed out in transform order, so they only mean something for
// the lifetime of one dev server. That holds because a server restart
// reloads every client and re-stamps every loc.
export function createLocSpace(): LocSpace {
  const decks = new Map<string, string[]>();
  return {
    encode(slideId, file, line) {
      if (file === DECK_ENTRY_FILE) return line;
      let files = decks.get(slideId);
      if (!files) {
        files = [];
        decks.set(slideId, files);
      }
      let index = files.indexOf(file);
      if (index === -1) index = files.push(file) - 1;
      return (index + 1) * LOC_FILE_STRIDE + line;
    },
    decode(slideId, line) {
      const band = Math.floor(line / LOC_FILE_STRIDE);
      if (band === 0) return { file: DECK_ENTRY_FILE, line };
      const file = decks.get(slideId)?.[band - 1];
      return file ? { file, line: sourceLine(line) } : null;
    },
    files(slideId) {
      return [DECK_ENTRY_FILE, ...(decks.get(slideId) ?? [])];
    },
  };
}
