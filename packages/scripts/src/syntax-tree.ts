import { panic } from "better-result";
import {
  type Comment,
  type EcmaScriptModule,
  parseSync,
  type Program,
} from "oxc-parser";

// Syntax-only reads of TypeScript and JavaScript sources. Guards and
// generators that need types use tsrs instead.
export { Visitor, type VisitorObject } from "oxc-parser";
// ESTree node types (`Node`, `CallExpression`, `TSTypeReference`, …).
export type * from "oxc-parser";

export type SourceLocation = {
  /** 1-based line. */
  readonly line: number;
  /** 1-based column in UTF-16 code units. */
  readonly column: number;
};

export type ParsedSource = {
  readonly program: Program;
  /** Every comment in source order. */
  readonly comments: readonly Comment[];
  /** Static imports, exports and dynamic imports as oxc records them. */
  readonly module: EcmaScriptModule;
  readonly sourceText: string;
  /** Location of a node's `start` or `end` (UTF-16 offsets). */
  readonly locate: (offset: number) => SourceLocation;
};

const lineStarts = (text: string): number[] => {
  const starts = [0];
  for (
    let newline = text.indexOf("\n");
    newline !== -1;
    newline = text.indexOf("\n", newline + 1)
  ) {
    starts.push(newline + 1);
  }
  return starts;
};

const locator = (text: string) => {
  let starts: number[] | undefined;
  return (offset: number): SourceLocation => {
    starts ??= lineStarts(text);
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 };
  };
};

/**
 * Parses a source file by its extension (`.ts`, `.tsx`, `.d.ts`, `.js`, …).
 * A syntax error stops the caller: a guard that skipped an unparsable file
 * would pass without reading it.
 */
export const parseSource = (
  fileName: string,
  sourceText: string,
): ParsedSource => {
  const result = parseSync(fileName, sourceText);
  const errors = result.errors.filter((error) => {
    // oxc-parser declares Severity as an ambient const enum of strings.
    const severity: string = error.severity;
    return severity === "Error";
  });
  if (errors.length > 0) {
    panic(
      `${fileName} does not parse; fix the syntax error before rerunning:\n${errors
        .map(({ codeframe, message }) => codeframe ?? message)
        .join("\n")}`,
    );
  }
  return {
    comments: result.comments,
    locate: locator(sourceText),
    module: result.module,
    program: result.program,
    sourceText,
  };
};
