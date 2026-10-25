import { panic } from "better-result";
import {
  type Comment,
  type EcmaScriptModule,
  type Node,
  parseSync,
  type Program,
  visitorKeys,
} from "oxc-parser";

// Syntax-only reads of TypeScript and JavaScript sources. Guards and
// generators that need types use tsrs instead.
export { Visitor, type VisitorObject } from "oxc-parser";
// ESTree node types (`Node`, `CallExpression`, `TSTypeReference`, …).
export type * from "oxc-parser";

/**
 * ESTree's own names. oxc types identifiers and properties by role (binding,
 * reference, object literal entry, pattern entry, …); these are every node
 * that carries the ESTree tag.
 */
export type IdentifierNode = Extract<Node, { type: "Identifier" }>;
export type PropertyNode = Extract<Node, { type: "Property" }>;
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

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

/**
 * Visits `root` and every descendant in source order, passing the node's
 * ancestors (nearest last). oxc nodes carry no parent links, so walkers that
 * need context read it from `ancestors`. Returning "skip-children" leaves the
 * node's subtree unvisited.
 */
export const walk = (
  root: Node,
  visit: (
    node: Node,
    ancestors: readonly Node[],
    // Any other return value, including none, visits the children.
  ) => unknown,
): void => {
  const ancestors: Node[] = [];
  const enter = (node: Node): void => {
    if (visit(node, ancestors) === "skip-children") {
      return;
    }
    ancestors.push(node);
    for (const key of visitorKeys[node.type] ?? []) {
      const child: unknown = Reflect.get(node, key);
      if (Array.isArray(child)) {
        for (const item of child) {
          if (isNode(item)) {
            enter(item);
          }
        }
      } else if (isNode(child)) {
        enter(child);
      }
    }
    ancestors.pop();
  };
  enter(root);
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
