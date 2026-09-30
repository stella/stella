import { panic, Result } from "better-result";
import { load } from "cheerio";
import { type AnyNode, hasChildren, isTag, isText } from "domhandler";
import * as slimdom from "slimdom";

import {
  TEXT_ORACLE_LIMITS,
  TextOracleError,
  type TextBaseline,
} from "./types";

/** Exclude only publisher furniture established by source evidence. */
export type MarkupTextExclusion = {
  type: "element";
  name: string;
  attribute?: { name: string; value: string };
  reason: string;
  evidence: string;
};

type ReadMarkupTextOptions = {
  raw: Uint8Array;
  exclusions?: readonly MarkupTextExclusion[];
} & ({ format: "html" } | { format: "xml"; xmlDialect?: MarkupXmlDialect });

const MAX_MARKUP_EXCLUSIONS = 64;

const HTML_INVISIBLE = new Set(["head", "script", "style", "template"]);
const HTML_BOUNDARIES = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "caption",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);
// These recipes add lexical boundaries only. They never choose a subtree or
// discard text, and generic XML preserves adjacent inline text by default.
const XML_DIALECT_BOUNDARIES = {
  generic: new Set(["p", "para", "paragraph", "br"]),
  xpart: new Set([
    "p",
    "para",
    "paragraph",
    "br",
    "xText",
    "xName",
    "xTitle",
    "xClmn",
    "xUnit",
    "xBlock",
    "xRow",
    "xGloss",
  ]),
  ris: new Set([
    "p",
    "para",
    "paragraph",
    "br",
    "absatz",
    "ueberschrift",
    "abschnitt",
    "abstand",
    "Textabsatz",
    "Textzeile",
  ]),
  findok: new Set(HTML_BOUNDARIES),
  formex: new Set([
    "P",
    "TITLE",
    "TI",
    "NP",
    "NP.ECR",
    "NO.P",
    "GR.SEQ",
    "ITEM",
    "NOTE",
    "TBL",
    "ROW",
    "CELL",
    "KEYWORD",
  ]),
} as const;

export type MarkupXmlDialect = keyof typeof XML_DIALECT_BOUNDARIES;

const malformed = (message: string) =>
  Result.err(new TextOracleError({ reason: "malformed", message }));
const resourceLimit = () =>
  Result.err(
    new TextOracleError({
      reason: "resource_limit",
      message: "Markup baseline exceeded its resource limit",
    }),
  );

type NodeFacts = {
  text?: string;
  name?: string;
  invisible: boolean;
  boundary: boolean;
  visibility?: "hidden" | "visible";
  attribute: (name: string) => string | undefined;
};

type WalkMarkupOptions<Node> = {
  root: Node;
  children: (node: Node) => readonly Node[];
  facts: (node: Node) => NodeFacts;
  exclusions: readonly MarkupTextExclusion[];
  budget?: { nodes: number };
};

const normalizeEvidence = (text: string) =>
  text.normalize("NFC").replace(/\s+/gu, " ").trim();

const walkMarkup = <Node>({
  root,
  children,
  facts,
  exclusions,
  budget = { nodes: 0 },
}: WalkMarkupOptions<Node>): Result<TextBaseline, TextOracleError> => {
  const matched = new Set<MarkupTextExclusion>();
  const chunks: string[] = [];
  let characterCount = 0;
  const stack = [
    {
      node: root,
      depth: 0,
      invisible: false,
      visibility: "visible",
      closing: false,
    },
  ];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) {
      break;
    }
    if (entry.closing) {
      if (!entry.invisible) {
        chunks.push("\n");
        characterCount++;
      }
      if (characterCount > TEXT_ORACLE_LIMITS.textCharacters) {
        return resourceLimit();
      }
      continue;
    }
    budget.nodes++;
    if (
      budget.nodes > TEXT_ORACLE_LIMITS.nodes ||
      entry.depth > TEXT_ORACLE_LIMITS.depth
    ) {
      return resourceLimit();
    }
    const info = facts(entry.node);
    let invisible = entry.invisible || info.invisible;
    const visibility = info.visibility ?? entry.visibility;
    for (const exclusion of exclusions) {
      if (info.name !== exclusion.name) {
        continue;
      }
      if (
        exclusion.attribute !== undefined &&
        info.attribute(exclusion.attribute.name) !== exclusion.attribute.value
      ) {
        continue;
      }
      const evidence = walkMarkup({
        root: entry.node,
        children,
        facts,
        exclusions: [],
        budget,
      });
      if (Result.isError(evidence)) {
        return evidence;
      }
      if (
        normalizeEvidence(evidence.value.text) !==
        normalizeEvidence(exclusion.evidence)
      ) {
        return malformed(
          "A declared markup exclusion did not match its text evidence",
        );
      }
      matched.add(exclusion);
      invisible = true;
    }
    if (!invisible && visibility !== "hidden" && info.boundary) {
      chunks.push("\n");
      characterCount++;
      stack.push({
        node: entry.node,
        depth: entry.depth,
        invisible,
        visibility,
        closing: true,
      });
    }
    if (!invisible && visibility !== "hidden" && info.text !== undefined) {
      chunks.push(info.text);
      characterCount += info.text.length;
    }
    if (characterCount > TEXT_ORACLE_LIMITS.textCharacters) {
      return resourceLimit();
    }
    const childNodes = children(entry.node);
    // Every node, including invisible descendants, participates in the budget.
    if (
      budget.nodes + stack.length + childNodes.length >
      TEXT_ORACLE_LIMITS.nodes
    ) {
      return resourceLimit();
    }
    for (let index = childNodes.length - 1; index >= 0; index--) {
      const child = childNodes.at(index);
      if (child !== undefined) {
        stack.push({
          node: child,
          depth: entry.depth + 1,
          invisible,
          visibility,
          closing: false,
        });
      }
    }
  }
  if (exclusions.some((exclusion) => !matched.has(exclusion))) {
    return malformed("A declared markup exclusion matched no element");
  }
  return Result.ok({ text: chunks.join("") });
};

const htmlFacts = (node: AnyNode): NodeFacts => {
  if (isText(node)) {
    return {
      text: node.data,
      invisible: false,
      boundary: false,
      attribute: () => undefined,
    };
  }
  if (!isTag(node)) {
    return { invisible: false, boundary: false, attribute: () => undefined };
  }
  const style = node.attribs["style"] ?? "";
  const declarations = style.split(";");
  const invisibleStyle = declarations.some((declaration) =>
    /^\s*display\s*:\s*none\s*(?:!important\s*)?$/iu.test(declaration),
  );
  const visibilityDeclaration = declarations.findLast((declaration) =>
    /^\s*visibility\s*:\s*(?:hidden|collapse|visible)\s*(?:!important\s*)?$/iu.test(
      declaration,
    ),
  );
  let visibility: NodeFacts["visibility"];
  if (visibilityDeclaration !== undefined) {
    if (/:\s*visible\b/iu.test(visibilityDeclaration)) {
      visibility = "visible";
    } else {
      visibility = "hidden";
    }
  }
  return {
    name: node.name,
    text: node.name === "img" ? node.attribs["alt"] : undefined,
    invisible:
      HTML_INVISIBLE.has(node.name) ||
      Object.hasOwn(node.attribs, "hidden") ||
      invisibleStyle,
    boundary: HTML_BOUNDARIES.has(node.name) || node.name === "img",
    visibility,
    attribute: (name) => node.attribs[name],
  };
};

type XmlFactsOptions = {
  node: slimdom.Node;
  dialect: MarkupXmlDialect;
  embeddedText: ReadonlyMap<slimdom.Node, string>;
};

const xmlFacts = ({
  node,
  dialect,
  embeddedText,
}: XmlFactsOptions): NodeFacts => {
  if (
    node.nodeType === slimdom.Node.TEXT_NODE ||
    node.nodeType === slimdom.Node.CDATA_SECTION_NODE
  ) {
    return {
      text: node.nodeValue ?? "",
      invisible: false,
      boundary: false,
      attribute: () => undefined,
    };
  }
  if (!(node instanceof slimdom.Element)) {
    return { invisible: false, boundary: false, attribute: () => undefined };
  }
  // Generic XML has no hidden-element convention. Even metadata and deleted
  // wrappers carry source text unless a caller supplies an evidenced exclusion.
  return {
    name: node.tagName,
    text: embeddedText.get(node),
    invisible: false,
    boundary:
      embeddedText.has(node) ||
      XML_DIALECT_BOUNDARIES[dialect].has(node.localName),
    attribute: (name) => node.getAttribute(name) ?? undefined,
  };
};

type ReadHtmlBaselineOptions = {
  source: string;
  exclusions: readonly MarkupTextExclusion[];
  budget: { nodes: number };
};

const readHtmlBaseline = ({
  source,
  exclusions,
  budget,
}: ReadHtmlBaselineOptions): Result<TextBaseline, TextOracleError> => {
  const parsed = Result.try(() => load(source));
  if (Result.isError(parsed)) {
    return malformed("HTML could not be parsed");
  }
  const root = parsed.value.root().get(0);
  if (root === undefined) {
    return malformed("HTML has no document root");
  }
  return walkMarkup({
    root,
    children: (node: AnyNode) => (hasChildren(node) ? node.children : []),
    facts: htmlFacts,
    exclusions,
    budget,
  });
};

type ReadFindokEmbeddedOptions = {
  root: slimdom.Node;
  budget: { nodes: number };
};

const readFindokEmbedded = ({
  root,
  budget,
}: ReadFindokEmbeddedOptions): Result<
  Map<slimdom.Node, string>,
  TextOracleError
> => {
  const embeddedText = new Map<slimdom.Node, string>();
  const stack = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) {
      break;
    }
    budget.nodes++;
    if (
      budget.nodes > TEXT_ORACLE_LIMITS.nodes ||
      entry.depth > TEXT_ORACLE_LIMITS.depth
    ) {
      return resourceLimit();
    }
    if (
      entry.node instanceof slimdom.Element &&
      entry.node.localName === "txt"
    ) {
      // FINDOK's txt holds entity-escaped XHTML, not child XML markup.
      // Process every occurrence; the remaining XML text stays in the baseline.
      const baseline = readHtmlBaseline({
        source: entry.node.textContent,
        exclusions: [],
        budget,
      });
      if (Result.isError(baseline)) {
        return baseline;
      }
      embeddedText.set(entry.node, baseline.value.text);
    }
    if (
      budget.nodes + stack.length + entry.node.childNodes.length >
      TEXT_ORACLE_LIMITS.nodes
    ) {
      return resourceLimit();
    }
    for (let index = entry.node.childNodes.length - 1; index >= 0; index--) {
      const child = entry.node.childNodes.at(index);
      if (child !== undefined) {
        stack.push({ node: child, depth: entry.depth + 1 });
      }
    }
  }
  return Result.ok(embeddedText);
};

export const readMarkupText = (
  options: ReadMarkupTextOptions,
): Result<TextBaseline, TextOracleError> => {
  const { raw, format, exclusions = [] } = options;
  if (raw.byteLength > TEXT_ORACLE_LIMITS.rawBytes) {
    return resourceLimit();
  }
  if (exclusions.length > MAX_MARKUP_EXCLUSIONS) {
    return resourceLimit();
  }
  if (
    exclusions.some(
      ({ name, reason, evidence }) =>
        name.trim() === "" || reason.trim() === "" || evidence.trim() === "",
    )
  ) {
    return malformed(
      "Markup exclusions require a name, reason and source evidence",
    );
  }
  const decoded = Result.try(() =>
    new TextDecoder("utf-8", { fatal: true }).decode(raw),
  );
  if (Result.isError(decoded)) {
    return malformed("Markup is not valid UTF-8");
  }
  const source = decoded.value;
  if (
    /<!ENTITY\b/iu.test(source) ||
    (format === "xml" && /<!DOCTYPE\b/iu.test(source))
  ) {
    return Result.err(
      new TextOracleError({
        reason: "unsupported",
        message: "Markup entity declarations and XML DTDs are unsupported",
      }),
    );
  }
  switch (format) {
    case "html":
      return readHtmlBaseline({ source, exclusions, budget: { nodes: 0 } });
    case "xml": {
      const parsed = Result.try(() => slimdom.parseXmlDocument(source));
      if (Result.isError(parsed)) {
        return malformed("XML is not well formed");
      }
      const dialect = options.xmlDialect ?? "generic";
      const budget = { nodes: 0 };
      const embedded =
        dialect === "findok"
          ? readFindokEmbedded({ root: parsed.value, budget })
          : Result.ok(new Map<slimdom.Node, string>());
      if (Result.isError(embedded)) {
        return embedded;
      }
      const embeddedText = embedded.value;
      return walkMarkup({
        root: parsed.value,
        children: (node: slimdom.Node) =>
          embeddedText.has(node) ? [] : node.childNodes,
        facts: (node: slimdom.Node) =>
          xmlFacts({ node, dialect, embeddedText }),
        exclusions,
        budget,
      });
    }
    default:
      format satisfies never;
      return panic("Unknown markup format");
  }
};
