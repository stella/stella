import { isInlineArray } from "./inline.js";
import type { Inline } from "./inline.js";

const isRecord = (val: unknown): val is Record<string, unknown> =>
  typeof val === "object" && val !== null;

export const PROVISION_KINDS = [
  "book",
  "part",
  "title",
  "division",
  "chapter",
  "subdivision",
  "article",
  "section",
  "paragraph",
  "subsection",
  "point",
  "letter",
  "indent",
  "preamble",
  "recital",
  "annex",
  "schedule",
] as const;

export type ProvisionKind = (typeof PROVISION_KINDS)[number];

export const STATUTE_STATUSES = [
  "as-enacted",
  "consolidated",
  "prospective",
  "repealed",
] as const;

export type StatuteStatus = (typeof STATUTE_STATUSES)[number];

const PROVISION_KIND_SET: ReadonlySet<string> = new Set(PROVISION_KINDS);
const STATUTE_STATUS_SET: ReadonlySet<string> = new Set(STATUTE_STATUSES);

export type StatuteSource = {
  system: string;
  eliExpressionUri: string | null;
  sourceUrl: string;
};

export type StatuteMetadata = {
  naturalId: string;
  title: string;
  language: string;
  status: StatuteStatus;
  validFrom: string;
  validTo: string | null;
};

export type ProvisionNode = {
  type: "provision";
  eId: string;
  wId: string;
  anchorId: string;
  kind: ProvisionKind;
  num: string | null;
  heading: Inline[] | null;
  plainText: string;
  children: StatuteBlock[];
};

export type StatuteParagraph = {
  type: "paragraph";
  eId: string;
  anchorId: string;
  inlines: Inline[];
  plainText: string;
};

export type StatuteList = {
  type: "list";
  eId: string;
  anchorId: string;
  ordered: boolean;
  items: StatuteListItem[];
};

export type StatuteListItem = {
  eId: string;
  marker: string | null;
  children: StatuteBlock[];
};

export type StatuteTableCell = {
  inlines: Inline[];
  plainText: string;
};

export type StatuteTable = {
  type: "table";
  eId: string;
  anchorId: string;
  rows: StatuteTableCell[][];
  plainText: string;
};

export type StatuteFootnote = {
  type: "footnote";
  eId: string;
  ref: string;
  inlines: Inline[];
  plainText: string;
};

export type StatuteEdit = {
  type: "edit";
  op: "ins" | "del" | "sunset" | "upcoming";
  effectiveDate: string | null;
  inlines: Inline[];
};

export type StatuteBlock =
  | ProvisionNode
  | StatuteParagraph
  | StatuteList
  | StatuteTable
  | StatuteFootnote
  | StatuteEdit;

export type StatuteAst = {
  version: 1;
  source: StatuteSource;
  metadata: StatuteMetadata;
  body: StatuteBlock[];
};

export const isProvisionKind = (val: unknown): val is ProvisionKind =>
  typeof val === "string" && PROVISION_KIND_SET.has(val);

export const isStatuteStatus = (val: unknown): val is StatuteStatus =>
  typeof val === "string" && STATUTE_STATUS_SET.has(val);

export const isStatuteAst = (val: unknown): val is StatuteAst =>
  isRecord(val) &&
  val["version"] === 1 &&
  isStatuteSource(val["source"]) &&
  isStatuteMetadata(val["metadata"]) &&
  Array.isArray(val["body"]) &&
  val["body"].every(isStatuteBlock);

export const parseStatuteAst = (raw: unknown): StatuteAst | null => {
  if (raw === null || raw === undefined) {
    return null;
  }

  if (typeof raw !== "string") {
    return isStatuteAst(raw) ? raw : null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isStatuteAst(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const isNullableString = (val: unknown): val is string | null =>
  typeof val === "string" || val === null;

const isStatuteSource = (val: unknown): val is StatuteSource =>
  isRecord(val) &&
  typeof val["system"] === "string" &&
  isNullableString(val["eliExpressionUri"]) &&
  typeof val["sourceUrl"] === "string";

const isStatuteMetadata = (val: unknown): val is StatuteMetadata =>
  isRecord(val) &&
  typeof val["naturalId"] === "string" &&
  typeof val["title"] === "string" &&
  typeof val["language"] === "string" &&
  isStatuteStatus(val["status"]) &&
  typeof val["validFrom"] === "string" &&
  isNullableString(val["validTo"]);

const isProvisionNode = (val: unknown): val is ProvisionNode =>
  isRecord(val) &&
  val["type"] === "provision" &&
  typeof val["eId"] === "string" &&
  typeof val["wId"] === "string" &&
  typeof val["anchorId"] === "string" &&
  isProvisionKind(val["kind"]) &&
  isNullableString(val["num"]) &&
  (val["heading"] === null || isInlineArray(val["heading"])) &&
  typeof val["plainText"] === "string" &&
  Array.isArray(val["children"]) &&
  val["children"].every(isStatuteBlock);

const isStatuteBlock = (val: unknown): val is StatuteBlock => {
  if (!isRecord(val) || typeof val["type"] !== "string") {
    return false;
  }

  if (val["type"] === "provision") {
    return isProvisionNode(val);
  }

  if (val["type"] === "paragraph") {
    return (
      typeof val["eId"] === "string" &&
      typeof val["anchorId"] === "string" &&
      isInlineArray(val["inlines"]) &&
      typeof val["plainText"] === "string"
    );
  }

  if (val["type"] === "list") {
    return (
      typeof val["eId"] === "string" &&
      typeof val["anchorId"] === "string" &&
      typeof val["ordered"] === "boolean" &&
      Array.isArray(val["items"]) &&
      val["items"].every(isStatuteListItem)
    );
  }

  if (val["type"] === "table") {
    return (
      typeof val["eId"] === "string" &&
      typeof val["anchorId"] === "string" &&
      Array.isArray(val["rows"]) &&
      val["rows"].every(isStatuteTableRow) &&
      typeof val["plainText"] === "string"
    );
  }

  if (val["type"] === "footnote") {
    return (
      typeof val["eId"] === "string" &&
      typeof val["ref"] === "string" &&
      isInlineArray(val["inlines"]) &&
      typeof val["plainText"] === "string"
    );
  }

  if (val["type"] !== "edit") {
    return false;
  }

  return (
    (val["op"] === "ins" ||
      val["op"] === "del" ||
      val["op"] === "sunset" ||
      val["op"] === "upcoming") &&
    isNullableString(val["effectiveDate"]) &&
    isInlineArray(val["inlines"])
  );
};

const isStatuteListItem = (val: unknown): val is StatuteListItem =>
  isRecord(val) &&
  typeof val["eId"] === "string" &&
  isNullableString(val["marker"]) &&
  Array.isArray(val["children"]) &&
  val["children"].every(isStatuteBlock);

const isStatuteTableCell = (val: unknown): val is StatuteTableCell =>
  isRecord(val) &&
  isInlineArray(val["inlines"]) &&
  typeof val["plainText"] === "string";

const isStatuteTableRow = (val: unknown): val is StatuteTableCell[] =>
  Array.isArray(val) && val.every(isStatuteTableCell);
