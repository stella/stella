import { Result } from "better-result";
import * as slimdom from "slimdom";

import {
  RETENTION_PROJECTION_FAILURE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

const AKN = "http://docs.oasis-open.org/legaldocml/ns/akn/3.0";
const PARAGRAPH_ELEMENTS = new Set(["p", "heading", "num", "td", "th"]);

/** Read all judgment text outside the metadata, including unrecognised units. */
const judgmentParagraphs = (judgment: slimdom.Element): string[] => {
  const paragraphs: string[] = [];
  let pending = "";
  const flush = () => {
    const text = pending.replace(/\s+/gu, " ").trim();
    if (text.length > 0) {
      paragraphs.push(text);
    }
    pending = "";
  };
  const visit = (node: slimdom.Node): void => {
    if (
      node.nodeType === slimdom.Node.TEXT_NODE ||
      node.nodeType === slimdom.Node.CDATA_SECTION_NODE
    ) {
      pending += node.nodeValue ?? "";
      return;
    }
    if (!(node instanceof slimdom.Element)) {
      return;
    }
    if (node.localName === "br" || node.localName === "eol") {
      pending += " ";
      return;
    }
    const boundary = PARAGRAPH_ELEMENTS.has(node.localName);
    if (boundary) {
      flush();
    }
    for (const child of node.childNodes) {
      visit(child);
    }
    if (boundary) {
      flush();
    }
  };
  for (const part of judgment.children) {
    if (part.namespaceURI !== AKN || part.localName !== "meta") {
      visit(part);
      flush();
    }
  }
  return paragraphs;
};

const projectUkFcl = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const xml = parts["document"];
  if (xml === undefined) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
    };
  }
  const parsed = Result.try(() => slimdom.parseXmlDocument(xml));
  if (parsed.isErr()) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_DOCUMENT,
    };
  }
  const judgments = Array.from(
    parsed.value.getElementsByTagNameNS(AKN, "judgment"),
  );
  const judgment = judgments.at(0);
  if (judgments.length !== 1 || judgment === undefined) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
    };
  }
  return {
    type: "source",
    source: { type: "paragraphs", paragraphs: judgmentParagraphs(judgment) },
  };
};

export const ukFclRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) => await Promise.resolve(projectUkFcl(sourceRaw)),
};
