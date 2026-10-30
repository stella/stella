import { panic } from "better-result";
import {
  type Comment,
  type EcmaScriptModule,
  type Node,
  type ObjectProperty,
  parseSync,
  type Program,
  visitorKeys,
} from "oxc-parser";

// Syntax-only reads of TypeScript and JavaScript sources. Guards and
// generators that need types use tsrs instead.
export { Visitor } from "oxc-parser";
// ESTree node types (`Node`, `CallExpression`, `TSTypeReference`, …).
export type * from "oxc-parser";

type SourceLocation = {
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

/**
 * oxc tags object literal entries and destructuring entries alike as
 * `Property`; only an entry of an object literal is an `ObjectProperty`, whose
 * value is an expression rather than a binding pattern.
 */
export const isObjectLiteralProperty = (
  node: Node,
  parent: Node | undefined,
): node is ObjectProperty =>
  node.type === "Property" &&
  parent?.type === "ObjectExpression" &&
  parent.properties.some((property) => property === node);

/** Computed identifiers are expressions, while uncomputed identifiers name keys. */
export const staticPropertyName = ({
  computed,
  key,
}: Pick<ObjectProperty, "computed" | "key">): string | undefined => {
  if (!computed && key.type === "Identifier") {
    return key.name;
  }
  if (key.type === "Literal" && typeof key.value === "string") {
    return key.value;
  }
  if (key.type === "TemplateLiteral" && key.expressions.length === 0) {
    return key.quasis.at(0)?.value.cooked ?? undefined;
  }
  return undefined;
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
    // Deserializing the tree costs more than parsing; readers of the module
    // record alone never build it.
    get program() {
      return result.program;
    },
    sourceText,
  };
};
