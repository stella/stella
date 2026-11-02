import path from "node:path";

// One oxc parse per (extension, text), shared by the ratchet counters.
//
// The ratchet runs dozens of counters over each file in turn, and most of them
// parse it. A parse is a pure function of the text and the dialect (the
// file name matters only for declaration files, which are never memoized), so
// the counters reading the same file share one tree instead of re-parsing it.
// The memo keeps only the most recent texts: the scan visits one file at a
// time, so a small window catches every repeat without holding the whole
// tree's syntax in memory.
import {
  type ParsedSource,
  parseSource as parseSyntaxTree,
} from "../packages/scripts/src/syntax-tree.ts";

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

type ParseSourceOptions = { fileName: string; text: string };

// oxc picks the grammar from the file extension.
export type SyntaxDialect = "js" | "jsx" | "ts" | "tsx";

export const syntaxDialect = (fileName: string): SyntaxDialect => {
  if (fileName.endsWith(".tsx")) {
    return "tsx";
  }
  if (fileName.endsWith(".jsx")) {
    return "jsx";
  }
  return /\.[cm]?js$/u.test(fileName) ? "js" : "ts";
};

// The extension selects grammar and module mode.
const RECENT_SYNTAX_TREES = new Map<string, RecentMemo<ParsedSource>>();

/** The oxc syntax tree of `text`, shared by every reader of the same text. */
export const parseSyntax = ({
  fileName,
  text,
}: ParseSourceOptions): ParsedSource => {
  const parse = () => parseSyntaxTree(fileName, text);
  if (DECLARATION_FILE_NAME.test(fileName)) {
    return parse();
  }
  const extension = path.extname(fileName);
  let memo = RECENT_SYNTAX_TREES.get(extension);
  if (memo === undefined) {
    memo = memoizeRecent<ParsedSource>(RECENT_TEXTS_PER_DIALECT);
    RECENT_SYNTAX_TREES.set(extension, memo);
  }
  return memo(text, parse);
};
