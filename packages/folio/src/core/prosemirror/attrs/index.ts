import type { Mark, Node as PMNode } from "prosemirror-model";

import type {
  HyperlinkAttrs,
  ImageAttrs,
  ParagraphAttrs,
  TableAttrs,
  TableCellAttrs,
  TableRowAttrs,
} from "../schema";

export type ProseMirrorAttrIssue = {
  path: string;
  message: string;
};

export type ReadProseMirrorAttrsResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ProseMirrorAttrIssue[] };

export const readParagraphAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<ParagraphAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeType(node, "paragraph", issues);

  optionalString(attrs, "paraId", "paragraph.attrs.paraId", issues);
  optionalString(attrs, "textId", "paragraph.attrs.textId", issues);
  optionalString(attrs, "styleId", "paragraph.attrs.styleId", issues);
  optionalNumber(attrs, "spaceBefore", "paragraph.attrs.spaceBefore", issues);
  optionalNumber(attrs, "spaceAfter", "paragraph.attrs.spaceAfter", issues);
  optionalNumber(attrs, "lineSpacing", "paragraph.attrs.lineSpacing", issues);
  optionalNumber(attrs, "outlineLevel", "paragraph.attrs.outlineLevel", issues);
  optionalNumber(
    attrs,
    "listMarkerFontSize",
    "paragraph.attrs.listMarkerFontSize",
    issues,
  );
  optionalNumber(
    attrs,
    "listStartOverride",
    "paragraph.attrs.listStartOverride",
    issues,
  );
  optionalBoolean(
    attrs,
    "renderedPageBreakBefore",
    "paragraph.attrs.renderedPageBreakBefore",
    issues,
  );
  optionalBoolean(
    attrs,
    "runInWithNext",
    "paragraph.attrs.runInWithNext",
    issues,
  );
  optionalStringArray(
    attrs,
    "listLevelNumFmts",
    "paragraph.attrs.listLevelNumFmts",
    issues,
  );
  optionalRecord(attrs, "numPr", "paragraph.attrs.numPr", issues);
  validateNumPr(attrs["numPr"], issues);
  optionalBookmarkArray(attrs["bookmarks"], issues);
  optionalRecord(
    attrs,
    "_sectionProperties",
    "paragraph.attrs._sectionProperties",
    issues,
  );
  optionalArray(
    attrs,
    "_propertyChanges",
    "paragraph.attrs._propertyChanges",
    issues,
  );

  return attrsResult(attrs, issues);
};

export const expectParagraphAttrs = (node: PMNode): ParagraphAttrs =>
  expectAttrs(readParagraphAttrs(node), "paragraph attrs");

export const readTableAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<TableAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeType(node, "table", issues);

  optionalString(attrs, "styleId", "table.attrs.styleId", issues);
  optionalNumber(attrs, "width", "table.attrs.width", issues);
  optionalString(attrs, "widthType", "table.attrs.widthType", issues);
  optionalNumberArray(
    attrs,
    "columnWidths",
    "table.attrs.columnWidths",
    issues,
  );
  optionalRecord(attrs, "floating", "table.attrs.floating", issues);
  optionalRecord(attrs, "cellMargins", "table.attrs.cellMargins", issues);
  optionalRecord(attrs, "look", "table.attrs.look", issues);
  optionalRecord(
    attrs,
    "_originalFormatting",
    "table.attrs._originalFormatting",
    issues,
  );

  return attrsResult(attrs, issues);
};

export const expectTableAttrs = (node: PMNode): TableAttrs =>
  expectAttrs(readTableAttrs(node), "table attrs");

export const readTableRowAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<TableRowAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeType(node, "tableRow", issues);

  optionalNumber(attrs, "height", "tableRow.attrs.height", issues);
  optionalString(attrs, "heightRule", "tableRow.attrs.heightRule", issues);
  optionalBoolean(attrs, "isHeader", "tableRow.attrs.isHeader", issues);
  optionalRecord(
    attrs,
    "_originalFormatting",
    "tableRow.attrs._originalFormatting",
    issues,
  );

  return attrsResult(attrs, issues);
};

export const expectTableRowAttrs = (node: PMNode): TableRowAttrs =>
  expectAttrs(readTableRowAttrs(node), "table row attrs");

export const readTableCellAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<TableCellAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeType(node, "tableCell", issues);

  requiredNumber(attrs, "colspan", "tableCell.attrs.colspan", issues);
  requiredNumber(attrs, "rowspan", "tableCell.attrs.rowspan", issues);
  optionalNumberArray(attrs, "colwidth", "tableCell.attrs.colwidth", issues, {
    allowNull: true,
  });
  optionalNumber(attrs, "width", "tableCell.attrs.width", issues);
  optionalString(attrs, "widthType", "tableCell.attrs.widthType", issues);
  optionalString(
    attrs,
    "verticalAlign",
    "tableCell.attrs.verticalAlign",
    issues,
  );
  optionalString(
    attrs,
    "backgroundColor",
    "tableCell.attrs.backgroundColor",
    issues,
  );
  optionalString(
    attrs,
    "textDirection",
    "tableCell.attrs.textDirection",
    issues,
  );
  optionalBoolean(attrs, "noWrap", "tableCell.attrs.noWrap", issues);
  optionalRecord(attrs, "borders", "tableCell.attrs.borders", issues);
  optionalRecord(attrs, "margins", "tableCell.attrs.margins", issues);
  optionalRecord(
    attrs,
    "_originalFormatting",
    "tableCell.attrs._originalFormatting",
    issues,
  );

  return attrsResult(attrs, issues);
};

export const expectTableCellAttrs = (node: PMNode): TableCellAttrs =>
  expectAttrs(readTableCellAttrs(node), "table cell attrs");

export const readImageAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<ImageAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeType(node, "image", issues);

  requiredString(attrs, "src", "image.attrs.src", issues);
  optionalString(attrs, "alt", "image.attrs.alt", issues);
  optionalString(attrs, "title", "image.attrs.title", issues);
  optionalString(attrs, "rId", "image.attrs.rId", issues);
  optionalNumber(attrs, "width", "image.attrs.width", issues);
  optionalNumber(attrs, "height", "image.attrs.height", issues);
  optionalString(attrs, "wrapType", "image.attrs.wrapType", issues);
  optionalString(attrs, "displayMode", "image.attrs.displayMode", issues);
  optionalString(attrs, "cssFloat", "image.attrs.cssFloat", issues);
  optionalRecord(attrs, "position", "image.attrs.position", issues);

  return attrsResult(attrs, issues);
};

export const expectImageAttrs = (node: PMNode): ImageAttrs =>
  expectAttrs(readImageAttrs(node), "image attrs");

export const readHyperlinkMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<HyperlinkAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkType(mark, "hyperlink", issues);

  requiredString(attrs, "href", "hyperlink.attrs.href", issues);
  optionalString(attrs, "tooltip", "hyperlink.attrs.tooltip", issues);
  optionalString(attrs, "rId", "hyperlink.attrs.rId", issues);

  return attrsResult(attrs, issues);
};

export const expectHyperlinkMarkAttrs = (mark: Mark): HyperlinkAttrs =>
  expectAttrs(readHyperlinkMarkAttrs(mark), "hyperlink attrs");

const attrsRecord = (attrs: unknown): Record<string, unknown> => {
  if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
    return attrs as Record<string, unknown>;
  }

  return {};
};

const attrsResult = <T>(
  attrs: Record<string, unknown>,
  issues: ProseMirrorAttrIssue[],
): ReadProseMirrorAttrsResult<T> => {
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  // SAFETY: this module is the ProseMirror FFI boundary. The checks above
  // validate the attrs this code relies on before exposing the typed shape.
  return { ok: true, value: attrs as T };
};

const expectAttrs = <T>(
  result: ReadProseMirrorAttrsResult<T>,
  label: string,
): T => {
  if (result.ok) {
    return result.value;
  }

  const details = result.issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid ProseMirror ${label}:\n${details}`);
};

const expectNodeType = (
  node: PMNode,
  expected: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  if (node.type.name !== expected) {
    issues.push({
      path: "node.type.name",
      message: `Expected ${expected}, got ${node.type.name}.`,
    });
  }
};

const expectMarkType = (
  mark: Mark,
  expected: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  if (mark.type.name !== expected) {
    issues.push({
      path: "mark.type.name",
      message: `Expected ${expected}, got ${mark.type.name}.`,
    });
  }
};

const requiredString = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  if (typeof attrs[key] !== "string") {
    issues.push({ path, message: "Expected a string." });
  }
};

const optionalString = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value !== undefined && value !== null && typeof value !== "string") {
    issues.push({ path, message: "Expected a string." });
  }
};

const requiredNumber = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  if (typeof attrs[key] !== "number") {
    issues.push({ path, message: "Expected a number." });
  }
};

const optionalNumber = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value !== undefined && value !== null && typeof value !== "number") {
    issues.push({ path, message: "Expected a number." });
  }
};

const optionalBoolean = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value !== undefined && value !== null && typeof value !== "boolean") {
    issues.push({ path, message: "Expected a boolean." });
  }
};

const optionalRecord = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (
    value !== undefined &&
    value !== null &&
    (typeof value !== "object" || Array.isArray(value))
  ) {
    issues.push({ path, message: "Expected an object." });
  }
};

const optionalArray = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value !== undefined && value !== null && !Array.isArray(value)) {
    issues.push({ path, message: "Expected an array." });
  }
};

type OptionalNumberArrayOptions = {
  allowNull?: boolean;
};

const optionalNumberArray = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
  options: OptionalNumberArrayOptions = {},
): void => {
  const value = attrs[key];
  if (value === null && options.allowNull === true) {
    return;
  }

  if (value === undefined || value === null) {
    return;
  }

  if (!Array.isArray(value)) {
    issues.push({ path, message: "Expected an array of numbers." });
    return;
  }

  for (const [index, item] of value.entries()) {
    if (typeof item !== "number") {
      issues.push({
        path: `${path}[${index}]`,
        message: "Expected a number.",
      });
    }
  }
};

const optionalStringArray = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value === undefined || value === null) {
    return;
  }

  if (!Array.isArray(value)) {
    issues.push({ path, message: "Expected an array of strings." });
    return;
  }

  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      issues.push({
        path: `${path}[${index}]`,
        message: "Expected a string.",
      });
    }
  }
};

const validateNumPr = (
  value: unknown,
  issues: ProseMirrorAttrIssue[],
): void => {
  if (value === undefined || value === null || Array.isArray(value)) {
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const numPr = value as Record<string, unknown>;
  if (numPr["numId"] !== undefined && typeof numPr["numId"] !== "number") {
    issues.push({
      path: "paragraph.attrs.numPr.numId",
      message: "Expected a number.",
    });
  }

  if (numPr["ilvl"] !== undefined && typeof numPr["ilvl"] !== "number") {
    issues.push({
      path: "paragraph.attrs.numPr.ilvl",
      message: "Expected a number.",
    });
  }
};

const optionalBookmarkArray = (
  value: unknown,
  issues: ProseMirrorAttrIssue[],
): void => {
  if (value === undefined || value === null) {
    return;
  }

  if (!Array.isArray(value)) {
    issues.push({
      path: "paragraph.attrs.bookmarks",
      message: "Expected an array of bookmarks.",
    });
    return;
  }

  for (const [index, bookmark] of value.entries()) {
    if (!bookmark || typeof bookmark !== "object" || Array.isArray(bookmark)) {
      issues.push({
        path: `paragraph.attrs.bookmarks[${index}]`,
        message: "Expected a bookmark object.",
      });
      continue;
    }

    const attrs = bookmark as Record<string, unknown>;
    if (typeof attrs["id"] !== "number") {
      issues.push({
        path: `paragraph.attrs.bookmarks[${index}].id`,
        message: "Expected a number.",
      });
    }
    if (typeof attrs["name"] !== "string") {
      issues.push({
        path: `paragraph.attrs.bookmarks[${index}].name`,
        message: "Expected a string.",
      });
    }
  }
};
