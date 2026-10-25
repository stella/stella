// One TypeScript parse per (dialect, text), shared by the ratchet's counters.
//
// The ratchet runs dozens of counters over each file in turn, and most of them
// parse it. A parse is a pure function of the text and the script kind (the
// file name matters only for declaration files, which are never memoized), so
// the counters reading the same file share one tree instead of re-parsing it.
// The memo keeps only the most recent texts: the scan visits one file at a
// time, so a small window catches every repeat without holding the whole
// tree's syntax in memory.
import {
  type ParsedSource,
  parseSource as parseSyntaxSource,
} from "../packages/scripts/src/syntax-tree";

type ParseDialect = "ts" | "tsx";

const RECENT_TEXTS_PER_DIALECT = 2;
const DECLARATION_FILE_NAME = /\.d\.[^/]*$/u;

type RecentMemo<V> = (text: string, compute: () => V) => V;

// A pure function of `text`, remembered for the last `capacity` texts.
export const memoizeRecent = <V>(capacity: number): RecentMemo<V> => {
  const recent = new Map<string, V>();
  return (text, compute) => {
    const cached = recent.get(text);
    if (cached !== undefined) {
      recent.delete(text);
      recent.set(text, cached);
      return cached;
    }
    const value = compute();
    recent.set(text, value);
    if (recent.size > capacity) {
      const oldest = recent.keys().next();
      if (oldest.done !== true) {
        recent.delete(oldest.value);
      }
    }
    return value;
  };
};

const RECENT_PARSES = {
  ts: memoizeRecent<ParsedSource>(RECENT_TEXTS_PER_DIALECT),
  tsx: memoizeRecent<ParsedSource>(RECENT_TEXTS_PER_DIALECT),
} as const satisfies Record<ParseDialect, RecentMemo<ParsedSource>>;

export const sourceDialect = (fileName: string): ParseDialect =>
  fileName.endsWith(".tsx") ? "tsx" : "ts";

type ParseSourceOptions = { fileName: string; text: string };

export const parseSource = ({
  fileName,
  text,
}: ParseSourceOptions): ParsedSource => {
  const dialect = sourceDialect(fileName);
  const parse = () => parseSyntaxSource(fileName, text);
  return DECLARATION_FILE_NAME.test(fileName)
    ? parse()
    : RECENT_PARSES[dialect](text, parse);
};
