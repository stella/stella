import { Result } from "better-result";
import * as slimdom from "slimdom";

import type {
  DecisionDocumentAst,
  Inline,
  ParagraphBlock,
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
  const inlines: Inline[] = [];
  for (const child of node.childNodes) {
    if (
      child.nodeType === slimdom.Node.TEXT_NODE ||
      child.nodeType === slimdom.Node.CDATA_SECTION_NODE
    ) {
      inlines.push({ type: "text", text: child.nodeValue ?? "" });
      continue;
    }
    if (!(child instanceof slimdom.Element)) {
      continue;
    }
    if (
      child.namespaceURI === AKN &&
      (child.localName === "num" || child.localName === "img")
    ) {
      continue;
    }
    const children = inlinesOf(child);
    const href = sanitizeUrl(child.getAttribute("href"));
    switch (child.namespaceURI === AKN ? child.localName : "") {
      case "ref":
        if (href !== undefined) {
          inlines.push({ type: "link", href, children });
        } else {
          inlines.push(...children);
        }
        break;
      case "b":
        inlines.push({ type: "bold", children });
        break;
      case "i":
        inlines.push({ type: "italic", children });
        break;
      case "br":
        inlines.push({ type: "line-break" });
        break;
      default:
        inlines.push(...children);
    }
  }
  return inlines;
};

const rejectedJudgment = (message: string) =>
  Result.err(new ParseXmlError({ message, cause: undefined }));

const headerBlocks = (header: slimdom.Element | undefined) => {
  const blocks: ParagraphBlock[] = [];
  for (const child of header?.childNodes ?? []) {
    if (text(child) === "") {
      continue;
    }
    const inlines = inlinesOf(child);
    const id =
      child instanceof slimdom.Element
        ? (child.getAttribute("eId") ?? `header-${blocks.length}`)
        : `header-${blocks.length}`;
    const role =
      child instanceof slimdom.Element &&
      /counsel|solicitor/iu.test(child.getAttribute("name") ?? "")
        ? "counsel"
        : "front-matter";
    blocks.push({
      type: "paragraph",
      id,
      anchorId: id,
      role,
      inlines,
      plainText: inlinesToPlainText(inlines),
    });
  }
  return blocks;
};

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
                .find(
                  (person) =>
                    `#${person.getAttribute("eId")}` ===
                    judge.getAttribute("refersTo"),
                )
                ?.getAttribute("showAs") ||
              "",
          }))
          .filter(({ nameAsPrinted }) => nameAsPrinted !== "");
  const blocks = headerBlocks(header);
  const bodyInlines = inlinesOf(body);
  const walk = (node: slimdom.Node): void => {
    if (!(node instanceof slimdom.Element)) {
      return;
    }
    const isTextBlock =
      node.localName === "paragraph" ||
      node.localName === "p" ||
      (elements(node, "paragraph").length === 0 &&
        elements(node, "p").length === 0);
    if (node.namespaceURI === AKN && isTextBlock && text(node) !== "") {
      const inlines = inlinesOf(node);
      const label = elements(node, "num").at(0)?.textContent?.trim() ?? "";
      const number = /^\d+\.?$/u.test(label)
        ? Number.parseInt(label, 10)
        : undefined;
      const id = node.getAttribute("eId") ?? `body-${blocks.length}`;
      blocks.push({
        type: "paragraph",
        id,
        anchorId: id,
        role: "argumentation",
        number,
        inlines,
        plainText: inlinesToPlainText(inlines),
      });
      return;
    }
    for (const child of node.childNodes) {
      walk(child);
    }
  };
  walk(body);
  const reasoning = blocks.filter(({ role }) => role === "argumentation");
  const fulltext = reasoning.map(({ plainText }) => plainText).join("\n\n");
  if (
    reasoning.length === 0 ||
    fulltext.replace(/\s/gu, "") !==
      inlinesToPlainText(bodyInlines).replace(/\s/gu, "")
  ) {
    return rejectedJudgment("Unmapped LegalDocML body text");
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
                  .find(
                    (role) =>
                      `#${role.getAttribute("eId")}` ===
                      party.getAttribute("as"),
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
