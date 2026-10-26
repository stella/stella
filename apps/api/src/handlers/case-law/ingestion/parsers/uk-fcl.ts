import { panic, Result } from "better-result";
import * as slimdom from "slimdom";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import type {
  Block,
  DecisionDocumentAst,
  Inline,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";
import { parsePlainDate } from "@stll/time";

import { ParseXmlError } from "@/api/handlers/case-law/ingestion/parsers/parse-xml-error";
import { inlinesToPlainText } from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";
import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { sanitizeUrl } from "@/api/lib/sanitize-url";

const AKN = "http://docs.oasis-open.org/legaldocml/ns/akn/3.0";
const UK = "https://caselaw.nationalarchives.gov.uk/akn";
const elements = (root: slimdom.Element | slimdom.Document, name: string) =>
  Array.from(root.getElementsByTagNameNS(AKN, name));
const attributes = (element: slimdom.Element) =>
  Object.fromEntries(
    Array.from(element.attributes, ({ name, value }) => [name, value]),
  );
const matchesReference = (
  element: slimdom.Element,
  reference: string | null,
) => {
  const id = element.getAttribute("eId");
  return id !== null && `#${id}` === reference;
};
const text = (node: slimdom.Node) =>
  (node.textContent ?? "").replace(/\s+/gu, " ").trim();

const fieldsOf = (document: slimdom.Document) => {
  const fields = new Map<
    string,
    { text: string; attributes: Record<string, string> }[]
  >();
  for (const element of document.getElementsByTagNameNS("*", "*")) {
    const field = {
      text: Array.from(element.childNodes)
        .filter(
          (node) =>
            node.nodeType === slimdom.Node.TEXT_NODE ||
            node.nodeType === slimdom.Node.CDATA_SECTION_NODE,
        )
        .map((node) => node.nodeValue ?? "")
        .join("")
        .trim(),
      attributes: attributes(element),
    };
    const group = fields.get(element.tagName);
    if (group === undefined) {
      fields.set(element.tagName, [field]);
    } else {
      group.push(field);
    }
  }
  return Object.fromEntries(fields);
};

const inlinesOf = (node: slimdom.Node): Inline[] => {
  if (
    node.nodeType === slimdom.Node.TEXT_NODE ||
    node.nodeType === slimdom.Node.CDATA_SECTION_NODE
  ) {
    return [{ type: "text", text: node.nodeValue ?? "" }];
  }
  if (!(node instanceof slimdom.Element)) {
    return [];
  }
  if (node.namespaceURI === AKN && node.localName === "img") {
    return [];
  }
  const children = Array.from(node.childNodes).flatMap(inlinesOf);
  switch (node.namespaceURI === AKN ? node.localName : "") {
    case "ref": {
      const href = sanitizeUrl(node.getAttribute("href"));
      return href === undefined ? children : [{ type: "link", href, children }];
    }
    case "b":
      return [{ type: "bold", children }];
    case "i":
      return [{ type: "italic", children }];
    case "br":
      return [{ type: "line-break" }];
    case "num":
      return [...children, { type: "text", text: " " }];
    default:
      return children;
  }
};

const BLOCK_ELEMENTS = new Set([
  "paragraph",
  "p",
  "heading",
  "block",
  "blockList",
  "item",
  "li",
  "list",
  "table",
  "tr",
  "td",
  "th",
]);
const isBlockElement = (node: slimdom.Node) =>
  node instanceof slimdom.Element &&
  node.namespaceURI === AKN &&
  BLOCK_ELEMENTS.has(node.localName);

// Read the source's text nodes directly, independently of inline rendering or AST construction.
const sourceTextOf = (root: slimdom.Node) => {
  const parts: string[] = [];
  const visit = (node: slimdom.Node): void => {
    if (
      node.nodeType === slimdom.Node.TEXT_NODE ||
      node.nodeType === slimdom.Node.CDATA_SECTION_NODE
    ) {
      parts.push(node.nodeValue ?? "");
      return;
    }
    if (
      node instanceof slimdom.Element &&
      node.namespaceURI === AKN &&
      (node.localName === "img" || node.localName === "meta")
    ) {
      return;
    }
    const separatesText =
      isBlockElement(node) ||
      (node.parentNode instanceof slimdom.Element &&
        node.parentNode.namespaceURI === AKN &&
        node.parentNode.localName === "judgment");
    if (separatesText) {
      parts.push("\n");
    }
    for (const child of node.childNodes) {
      visit(child);
    }
    if (
      node instanceof slimdom.Element &&
      node.namespaceURI === AKN &&
      node.localName === "num"
    ) {
      parts.push(" ");
    } else if (
      separatesText ||
      (node instanceof slimdom.Element &&
        node.namespaceURI === AKN &&
        node.localName === "br")
    ) {
      parts.push("\n");
    }
  };
  visit(root);
  return parts.join("");
};

const createBlockIds = (judgment: slimdom.Element) => {
  const reserved = new Set(
    Array.from(judgment.getElementsByTagNameNS("*", "*")).flatMap((node) => {
      const id = node.getAttribute("eId");
      return id === null ? [] : [id];
    }),
  );
  const used = new Set<string>();
  const occurrences = new Map<string, { suffix: number; ordinal: number }>();
  type AllocateIdOptions = { sourceId: string | undefined; prefix: string };
  return ({ sourceId, prefix }: AllocateIdOptions) => {
    const base = sourceId ?? `${prefix}-${used.size}`;
    const occurrenceKey =
      sourceId === undefined ? `generated:${base}` : `published:${base}`;
    const previous = occurrences.get(occurrenceKey);
    const ordinal = (previous?.ordinal ?? 0) + 1;
    let suffix = (previous?.suffix ?? 0) + 1;
    let id = suffix === 1 ? base : `${base}-${suffix}`;
    while (used.has(id) || (id !== sourceId && reserved.has(id))) {
      suffix++;
      id = `${base}-${suffix}`;
    }
    occurrences.set(occurrenceKey, { suffix, ordinal });
    used.add(id);
    return { id, ordinal };
  };
};

type BlockContext = {
  anchorId: string | undefined;
  number: number | undefined;
  role: ParagraphRole;
};
type BlocksOptions = {
  root: slimdom.Element;
  role: ParagraphRole;
  allocateId: ReturnType<typeof createBlockIds>;
};
const blocksOf = ({ root, role, allocateId }: BlocksOptions) => {
  const blocks: Block[] = [];
  const structuralDescendants = new Map<slimdom.Node, boolean>();
  const inspect = (node: slimdom.Node): boolean => {
    let structural = false;
    for (const child of node.childNodes) {
      const nested = inspect(child);
      if (isBlockElement(child) || nested) {
        structural = true;
      }
    }
    structuralDescendants.set(node, structural);
    return structural;
  };
  inspect(root);
  const hasStructure = (node: slimdom.Node) => {
    const structural = structuralDescendants.get(node);
    if (structural === undefined) {
      return panic("LegalDocML node was not inspected");
    }
    return structural;
  };
  type EmitBlockOptions = {
    node: slimdom.Element;
    inlines: Inline[];
    context: BlockContext;
  };
  const emit = ({ node, inlines, context }: EmitBlockOptions) => {
    const plainText = inlinesToPlainText(inlines).trim();
    if (plainText === "") {
      return;
    }
    const { id, ordinal } = allocateId({
      sourceId: context.anchorId,
      prefix: role,
    });
    if (node.namespaceURI === AKN && node.localName === "heading") {
      blocks.push({
        type: "heading",
        id,
        anchorId: id,
        level: 1,
        role: "section-heading",
        inlines,
        plainText,
      });
      return;
    }
    blocks.push({
      type: "paragraph",
      id,
      anchorId: id,
      role: context.role,
      number: ordinal === 1 ? context.number : undefined,
      inlines,
      plainText,
    });
  };
  type WalkBlockOptions = {
    node: slimdom.Element;
    inherited: BlockContext;
    prefix: Inline[];
  };
  const walk = ({ node, inherited, prefix }: WalkBlockOptions) => {
    const label = Array.from(node.children)
      .find((child) => child.namespaceURI === AKN && child.localName === "num")
      ?.textContent?.trim();
    const numericLabel =
      label !== undefined && /^\d+\.?$/u.test(label)
        ? parseIntegerToken(label.replace(/\.$/u, ""), {
            sign: "unsigned",
          }).unwrapOr(undefined)
        : undefined;
    const context = {
      anchorId: node.getAttribute("eId") ?? inherited.anchorId,
      number: label === undefined ? inherited.number : numericLabel,
      role: /counsel|solicitor/iu.test(node.getAttribute("name") ?? "")
        ? "counsel"
        : inherited.role,
    } satisfies BlockContext;
    if (!hasStructure(node)) {
      emit({ node, inlines: [...prefix, ...inlinesOf(node)], context });
      return;
    }
    let pending = prefix;
    let labelOnly = true;
    for (const child of node.childNodes) {
      if (
        child instanceof slimdom.Element &&
        (isBlockElement(child) || hasStructure(child))
      ) {
        if (!labelOnly) {
          emit({ node, inlines: pending, context });
          pending = [];
        }
        walk({ node: child, inherited: context, prefix: pending });
        pending = [];
        labelOnly = true;
      } else {
        pending.push(...inlinesOf(child));
        if (
          !(
            child instanceof slimdom.Element &&
            child.namespaceURI === AKN &&
            child.localName === "num"
          ) &&
          text(child) !== ""
        ) {
          labelOnly = false;
        }
      }
    }
    emit({ node, inlines: pending, context });
  };
  walk({
    node: root,
    inherited: { anchorId: undefined, number: undefined, role },
    prefix: [],
  });
  return blocks;
};

const judgmentPartRole = (part: slimdom.Element) => {
  if (part.namespaceURI !== AKN) {
    return undefined;
  }
  switch (part.localName) {
    case "header":
      return "front-matter";
    case "judgmentBody":
      return "argumentation";
    case "conclusions":
      return "closing";
    default:
      return undefined;
  }
};

const judgmentBlocksOf = (judgment: slimdom.Element) => {
  const allocateId = createBlockIds(judgment);
  const blocks: Block[] = [];
  const substantive: Block[] = [];
  for (const part of judgment.children) {
    const role = judgmentPartRole(part);
    if (role === undefined) {
      continue;
    }
    const partBlocks = blocksOf({ root: part, role, allocateId });
    blocks.push(...partBlocks);
    if (role !== "front-matter") {
      substantive.push(...partBlocks);
    }
  }
  return { blocks, substantive };
};

const rejectedJudgment = (message: string) =>
  Result.err(new ParseXmlError({ message, cause: undefined }));

type ParseUkFclInput = { xml: string; documentId: string; sourceUrl: string };

export const parseUkFclDecision = ({
  xml,
  documentId,
  sourceUrl,
}: ParseUkFclInput) => {
  const parsed = Result.try({
    try: () => slimdom.parseXmlDocument(xml),
    catch: (cause) =>
      new ParseXmlError({ message: "Invalid LegalDocML XML", cause }),
  });
  if (Result.isError(parsed)) {
    return parsed;
  }
  const document = parsed.value;
  const judgment = elements(document, "judgment").at(0);
  if (
    document.doctype !== null ||
    document.documentElement?.namespaceURI !== AKN ||
    document.documentElement.localName !== "akomaNtoso" ||
    judgment === undefined ||
    elements(document, "judgment").length !== 1
  ) {
    return rejectedJudgment("Invalid LegalDocML judgment root");
  }
  const body = elements(judgment, "judgmentBody").at(0);
  const court = Array.from(judgment.getElementsByTagNameNS(UK, "court"))
    .at(0)
    ?.textContent?.trim();
  const caseNumber = Array.from(judgment.getElementsByTagNameNS(UK, "cite"))
    .at(0)
    ?.textContent?.trim();
  const work = elements(judgment, "FRBRWork").at(0);
  const dates = work === undefined ? [] : elements(work, "FRBRdate");
  const decisionDate = dates
    .find((date) => date.getAttribute("name") === "judgment")
    ?.getAttribute("date");
  if (
    body === undefined ||
    !court ||
    !caseNumber ||
    !decisionDate ||
    parsePlainDate(decisionDate) === null
  ) {
    return rejectedJudgment("Incomplete LegalDocML judgment");
  }
  const caseName =
    (work === undefined
      ? undefined
      : elements(work, "FRBRname").at(0)?.getAttribute("value")) ?? undefined;
  const people = elements(judgment, "TLCPerson");
  const roles = elements(judgment, "TLCRole");
  const header = elements(judgment, "header").at(0);
  const judges =
    header === undefined
      ? []
      : elements(header, "judge")
          .map((judge) => ({
            role: DECISION_JUDGE_ROLE.PANEL_MEMBER,
            nameAsPrinted:
              text(judge) ||
              people
                .find((person) =>
                  matchesReference(person, judge.getAttribute("refersTo")),
                )
                ?.getAttribute("showAs") ||
              "",
          }))
          .filter(({ nameAsPrinted }) => nameAsPrinted !== "");
  const { blocks, substantive } = judgmentBlocksOf(judgment);
  const fulltext = substantive.map(({ plainText }) => plainText).join("\n\n");
  const normalized = (value: string) => value.replace(/\s+/gu, " ").trim();
  if (
    substantive.length === 0 ||
    normalized(blocks.map(({ plainText }) => plainText).join("\n")) !==
      normalized(sourceTextOf(judgment))
  ) {
    return rejectedJudgment("Unmapped LegalDocML judgment text");
  }
  const documentAst: DecisionDocumentAst = {
    version: 1,
    source: {
      system: "caselaw.nationalarchives.gov.uk",
      documentId,
      webUrl: sourceUrl,
      printUrl: "",
    },
    metadata: {
      caseNumber,
      court,
      decisionDate,
      ecli: null,
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks,
  };
  const sections: DecisionSection[] = [
    { index: 0, type: "argumentation", title: null, text: fulltext },
  ];
  return Result.ok({
    documentAst,
    fulltext,
    sections,
    caseNumber,
    court,
    decisionDate,
    caseName,
    judges,
    metadata: {
      xmlFields: fieldsOf(document),
      parties:
        header === undefined
          ? []
          : elements(header, "party").map((party) => ({
              name: text(party),
              person: attributes(party),
              role:
                roles
                  .find((role) =>
                    matchesReference(role, party.getAttribute("as")),
                  )
                  ?.getAttribute("showAs") ?? undefined,
            })),
      inlineReferences: elements(judgment, "ref").map((ref) => ({
        text: text(ref),
        attributes: attributes(ref),
      })),
      header: header === undefined ? undefined : text(header),
      images: {
        type: "absent",
        reason: "not_collected",
        detail: "Image assets are outside the document text capture",
      },
    },
  });
};
