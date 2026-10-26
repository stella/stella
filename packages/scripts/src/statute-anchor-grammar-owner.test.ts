import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

/**
 * Statute anchor grammar has one owner: the publisher scheme in
 * `packages/legal-ast/src/statute-anchor-scheme.ts`. Every other reading of
 * an anchor's path goes through it, so no surface can cut a Slov-Lex
 * `paragraf-36.pismeno-a` on e-Sbírka's `-`, or a US `s2000e-2/a` on a
 * section number's hyphen.
 *
 * This guard parses the production sources that read statute anchors and
 * fails where one states a separator (`-`, `.`, `/`, `~`) next to an
 * anchor:
 *
 * - a separator literal or a regular expression handed to a string method
 *   of an anchor (`anchorId.split("-")`);
 * - a string method handed an anchor joined to a separator
 *   (`` child.startsWith(`${parentAnchor}-`) ``);
 * - an anchor joined to nothing but a separator (`` `-${anchorId}` ``,
 *   `anchor + "."`), which only a path step needs;
 * - a separator literal in a binding that names anchors
 *   (`ANCHOR_SEPARATORS = ["-", "/"]`).
 *
 * "Anchor" is any expression or binding whose source text names one, which
 * is how every anchor value in these trees is named. A template that joins
 * an anchor into a key or an id (`` `${anchor}-${start}` ``) reads no path,
 * so it passes.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

const SCANNED_ROOTS = [
  "packages/legal-ast/src",
  "packages/decision-reader/src",
  "packages/mcp-apps/src",
  "apps/api/src",
  "apps/web/src",
] as const;

const OWNER = "packages/legal-ast/src/statute-anchor-scheme.ts";

/** Tests, fixtures and generated output state anchors as data, not grammar. */
const isProductionSource = (file: string): boolean =>
  !/\.(?:test|spec|test-helper|fixtures)\.tsx?$|\.gen\.ts$|\.d\.ts$/u.test(
    file,
  ) &&
  !/(?:^|\/)(?:__fixtures__|fixtures|__snapshots__|generated|tests)\//u.test(
    file,
  );

const ANCHOR_NAME = /anchor/iu;
const SEPARATOR_ONLY = /^[-./~]+$/u;
const OPENS_OR_CLOSES_WITH_SEPARATOR = /^[-./~]|[-./~]$/u;

const STRING_METHODS = new Set([
  "endsWith",
  "includes",
  "indexOf",
  "lastIndexOf",
  "match",
  "matchAll",
  "replace",
  "replaceAll",
  "search",
  "split",
  "startsWith",
]);

const namesAnchor = (node: ts.Node, source: ts.SourceFile): boolean =>
  ANCHOR_NAME.test(node.getText(source));

const isPlainString = (
  node: ts.Node,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

const templateTexts = (node: ts.TemplateExpression): string[] => [
  node.head.text,
  ...node.templateSpans.map(({ literal }) => literal.text),
];

/** Whether a template joins an anchor-named value to a separator. */
const joinsAnchorToSeparator = (
  node: ts.TemplateExpression,
  source: ts.SourceFile,
): boolean => {
  let before = node.head.text;
  for (const span of node.templateSpans) {
    if (
      namesAnchor(span.expression, source) &&
      (/[-./~]$/u.test(before) || /^[-./~]/u.test(span.literal.text))
    ) {
      return true;
    }
    before = span.literal.text;
  }
  return false;
};

/** `` `-${anchorId}` ``: one anchor and nothing but a separator around it. */
const isAnchorPathStep = (
  node: ts.TemplateExpression,
  source: ts.SourceFile,
): boolean => {
  const [span] = node.templateSpans;
  const texts = templateTexts(node).filter((text) => text !== "");
  return (
    node.templateSpans.length === 1 &&
    span !== undefined &&
    namesAnchor(span.expression, source) &&
    texts.length > 0 &&
    texts.every((text) => SEPARATOR_ONLY.test(text))
  );
};

type SeparatorArgumentOptions = {
  argument: ts.Expression;
  receiverNamesAnchor: boolean;
  source: ts.SourceFile;
};

/** An argument that states a separator to a string method reading an anchor. */
const isSeparatorArgument = ({
  argument,
  receiverNamesAnchor,
  source,
}: SeparatorArgumentOptions): boolean => {
  if (isPlainString(argument)) {
    return receiverNamesAnchor && SEPARATOR_ONLY.test(argument.text);
  }
  if (ts.isRegularExpressionLiteral(argument)) {
    return receiverNamesAnchor;
  }
  if (ts.isTemplateExpression(argument)) {
    return (
      joinsAnchorToSeparator(argument, source) ||
      (receiverNamesAnchor &&
        templateTexts(argument)
          .filter((text) => text !== "")
          .some((text) => OPENS_OR_CLOSES_WITH_SEPARATOR.test(text)))
    );
  }
  return false;
};

/** An identifier, a property read or a call: a value, never prose. */
const isValueExpression = (node: ts.Expression): boolean =>
  ts.isIdentifier(node) ||
  ts.isPropertyAccessExpression(node) ||
  ts.isElementAccessExpression(node) ||
  ts.isCallExpression(node);

/** The name a declaration or property binds, when it is one. */
const boundName = (node: ts.Node): ts.Node | null => {
  if (
    (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
    node.initializer !== undefined
  ) {
    return node.name;
  }
  return null;
};

/** Whether any string literal under `node` is a separator alone. */
const holdsSeparatorLiteral = (node: ts.Node): boolean => {
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) {
      return;
    }
    if (isPlainString(child) && SEPARATOR_ONLY.test(child.text)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
};

type Finding = { file: string; line: number; text: string };

/** Each place a source states a separator next to an anchor. */
const grammarFindings = (file: string, text: string): Finding[] => {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: Finding[] = [];
  const report = (node: ts.Node) => {
    const { line } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    findings.push({
      file,
      line: line + 1,
      text: node.getText(source).split("\n").at(0) ?? "",
    });
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      STRING_METHODS.has(node.expression.name.text)
    ) {
      const argument = node.arguments.at(0);
      if (
        argument !== undefined &&
        isSeparatorArgument({
          argument,
          receiverNamesAnchor: namesAnchor(node.expression.expression, source),
          source,
        })
      ) {
        report(node);
      }
    }
    if (ts.isTemplateExpression(node) && isAnchorPathStep(node, source)) {
      report(node);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      [
        [node.left, node.right],
        [node.right, node.left],
      ].some(
        ([anchor, other]) =>
          anchor !== undefined &&
          other !== undefined &&
          isValueExpression(anchor) &&
          namesAnchor(anchor, source) &&
          isPlainString(other) &&
          OPENS_OR_CLOSES_WITH_SEPARATOR.test(other.text),
      )
    ) {
      report(node);
    }
    const name = boundName(node);
    if (
      name !== null &&
      namesAnchor(name, source) &&
      holdsSeparatorLiteral(node)
    ) {
      report(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
};

const productionSources = (): string[] =>
  SCANNED_ROOTS.flatMap((root) =>
    [
      ...new Bun.Glob(`${root}/**/*.{ts,tsx}`).scanSync({
        cwd: repositoryRoot,
      }),
    ].filter((file) => file !== OWNER && isProductionSource(file)),
  ).toSorted();

describe("statute anchor grammar", () => {
  // timeout: parses every production source of five trees that names an anchor.
  test("is stated only by the publisher scheme", () => {
    const findings = productionSources().flatMap((file) => {
      const text = readFileSync(path.join(repositoryRoot, file), "utf-8");
      // Only a source that names an anchor can state its grammar.
      return ANCHOR_NAME.test(text) ? grammarFindings(file, text) : [];
    });
    expect(findings).toEqual([]);
  }, 60_000);

  test("the guard reaches every hand-coded shape it bans", () => {
    // The shapes the scheme replaced, as they were written before it.
    const banned = [
      'const NESTED_ANCHOR_SEPARATORS = ["-", "/"] as const;',
      'const parts = anchorId.split("-");',
      'const parts = block.anchorId.split(".");',
      "const parts = anchor.split(/[-.]/u);",
      `const nested = child.startsWith(\`\${parent.anchorId}-\`);`,
      `const suffix = \`-\${requestedAnchorId}\`;`,
      'const value = anchorId.replace(/~\\d+$/u, "");',
      'const child = parentAnchor + ".";',
      'const scheme = { anchorSeparator: "." };',
    ];
    expect(
      banned.map(
        (line) => grammarFindings("probe.ts", line).length > 0 && line,
      ),
    ).toEqual(banned);
    // A selector, a key or prose that merely carries an anchor is no grammar.
    expect(
      grammarFindings(
        "probe.tsx",
        [
          `const selector = \`[data-anchor="\${CSS.escape(anchorId)}"]\`;`,
          `const key = \`\${row.anchor}-\${String(row.spanStart)}\`;`,
          "const parts = anchor.split(separator);",
          'const hint = "Pick an anchor from the outline. " + "-";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("scans the trees that read statute anchors", () => {
    const sources = productionSources();
    for (const root of SCANNED_ROOTS) {
      expect({
        root,
        scanned: sources.some((file) => file.startsWith(`${root}/`)),
      }).toEqual({ root, scanned: true });
    }
    expect(sources).toContain("packages/legal-ast/src/provision-preview.ts");
    expect(sources).not.toContain(OWNER);
  });
});
