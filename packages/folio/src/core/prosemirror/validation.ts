import type { Mark, Node as PMNode } from "prosemirror-model";

import type { ProseMirrorAttrIssue, ReadProseMirrorAttrsResult } from "./attrs";
import {
  readCharacterSpacingMarkAttrs,
  readCommentMarkAttrs,
  readEmphasisMarkAttrs,
  readFieldAttrs,
  readFontFamilyMarkAttrs,
  readFontSizeMarkAttrs,
  readFootnoteRefMarkAttrs,
  readHardBreakAttrs,
  readHighlightMarkAttrs,
  readHyperlinkMarkAttrs,
  readImageAttrs,
  readMathAttrs,
  readParagraphAttrs,
  readRunFormattingOverrideMarkAttrs,
  readSdtAttrs,
  readShapeAttrs,
  readStrikeMarkAttrs,
  readTableAttrs,
  readTableCellAttrs,
  readTableRowAttrs,
  readTextBoxAttrs,
  readTextColorMarkAttrs,
  readTrackedChangeMarkAttrs,
  readUnderlineMarkAttrs,
} from "./attrs";

export type ProseMirrorDocumentValidationIssue = {
  path: string;
  message: string;
};

export type ValidateProseMirrorDocumentResult = {
  valid: boolean;
  issues: ProseMirrorDocumentValidationIssue[];
};

export class ProseMirrorDocumentValidationError extends Error {
  readonly issues: ProseMirrorDocumentValidationIssue[];

  constructor(context: string, issues: ProseMirrorDocumentValidationIssue[]) {
    super(`${context}:\n${formatProseMirrorDocumentIssues(issues).join("\n")}`);
    this.name = "ProseMirrorDocumentValidationError";
    this.issues = issues;
  }
}

const validDocumentCache = new WeakSet<PMNode>();
const validNodeCache = new WeakSet<PMNode>();

export const validateProseMirrorDocument = (
  doc: PMNode,
): ValidateProseMirrorDocumentResult => {
  const issues: ProseMirrorDocumentValidationIssue[] = [];

  if (doc.type.name !== "doc") {
    issues.push({
      path: "doc.type.name",
      message: `Expected doc, got ${doc.type.name}.`,
    });
  }

  validateNode(doc, "doc", issues);

  return {
    valid: issues.length === 0,
    issues,
  };
};

export const assertValidProseMirrorDocument = (
  doc: PMNode,
  context: string,
): void => {
  if (validDocumentCache.has(doc)) {
    return;
  }

  const validation = validateProseMirrorDocument(doc);
  if (validation.valid) {
    validDocumentCache.add(doc);
    return;
  }

  throw new ProseMirrorDocumentValidationError(context, validation.issues);
};

export const formatProseMirrorDocumentIssues = (
  issues: ProseMirrorDocumentValidationIssue[],
): string[] =>
  issues.map(
    (issue) => `ProseMirror document error at ${issue.path}: ${issue.message}`,
  );

const validateNode = (
  node: PMNode,
  path: string,
  issues: ProseMirrorDocumentValidationIssue[],
): void => {
  if (validNodeCache.has(node)) {
    return;
  }

  const issueCountBeforeNode = issues.length;

  validateNodeAttrs(node, path, issues);
  validateMarks(node.marks, path, issues);

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child, _offset, index) => {
    validateNode(child, `${path}.content[${index}]`, issues);
  });

  if (issues.length === issueCountBeforeNode) {
    validNodeCache.add(node);
  }
};

const validateNodeAttrs = (
  node: PMNode,
  path: string,
  issues: ProseMirrorDocumentValidationIssue[],
): void => {
  switch (node.type.name) {
    case "doc":
    case "text":
    case "horizontalRule":
    case "pageBreak":
    case "tab":
      return;

    case "hardBreak":
      appendAttrIssues(path, readHardBreakAttrs(node), issues);
      return;

    case "paragraph":
      appendAttrIssues(path, readParagraphAttrs(node), issues);
      return;

    case "table":
      appendAttrIssues(path, readTableAttrs(node), issues);
      return;

    case "tableRow":
      appendAttrIssues(path, readTableRowAttrs(node), issues);
      return;

    case "tableCell":
    case "tableHeader":
      appendAttrIssues(path, readTableCellAttrs(node), issues);
      return;

    case "image":
      appendAttrIssues(path, readImageAttrs(node), issues);
      return;

    case "field":
      appendAttrIssues(path, readFieldAttrs(node), issues);
      return;

    case "math":
      appendAttrIssues(path, readMathAttrs(node), issues);
      return;

    case "sdt":
      appendAttrIssues(path, readSdtAttrs(node), issues);
      return;

    case "shape":
      appendAttrIssues(path, readShapeAttrs(node), issues);
      return;

    case "textBox":
      appendAttrIssues(path, readTextBoxAttrs(node), issues);
      return;

    default:
      issues.push({
        path: `${path}.type.name`,
        message: `Unsupported ProseMirror node type ${node.type.name}.`,
      });
  }
};

const validateMarks = (
  marks: readonly Mark[],
  path: string,
  issues: ProseMirrorDocumentValidationIssue[],
): void => {
  for (const [index, mark] of marks.entries()) {
    const markPath = `${path}.marks[${index}]`;
    switch (mark.type.name) {
      case "bold":
      case "italic":
      case "subscript":
      case "superscript":
      case "allCaps":
      case "smallCaps":
      case "emboss":
      case "imprint":
      case "hidden":
      case "textShadow":
      case "textOutline":
        continue;

      case "underline":
        appendAttrIssues(markPath, readUnderlineMarkAttrs(mark), issues);
        continue;

      case "strike":
        appendAttrIssues(markPath, readStrikeMarkAttrs(mark), issues);
        continue;

      case "textColor":
        appendAttrIssues(markPath, readTextColorMarkAttrs(mark), issues);
        continue;

      case "highlight":
        appendAttrIssues(markPath, readHighlightMarkAttrs(mark), issues);
        continue;

      case "fontSize":
        appendAttrIssues(markPath, readFontSizeMarkAttrs(mark), issues);
        continue;

      case "fontFamily":
        appendAttrIssues(markPath, readFontFamilyMarkAttrs(mark), issues);
        continue;

      case "characterSpacing":
        appendAttrIssues(markPath, readCharacterSpacingMarkAttrs(mark), issues);
        continue;

      case "emphasisMark":
        appendAttrIssues(markPath, readEmphasisMarkAttrs(mark), issues);
        continue;

      case "footnoteRef":
        appendAttrIssues(markPath, readFootnoteRefMarkAttrs(mark), issues);
        continue;

      case "comment":
        appendAttrIssues(markPath, readCommentMarkAttrs(mark), issues);
        continue;

      case "insertion":
      case "deletion":
        appendAttrIssues(markPath, readTrackedChangeMarkAttrs(mark), issues);
        continue;

      case "runFormattingOverride":
        appendAttrIssues(
          markPath,
          readRunFormattingOverrideMarkAttrs(mark),
          issues,
        );
        continue;

      case "hyperlink":
        appendAttrIssues(markPath, readHyperlinkMarkAttrs(mark), issues);
        continue;

      default:
        issues.push({
          path: `${markPath}.type.name`,
          message: `Unsupported ProseMirror mark type ${mark.type.name}.`,
        });
    }
  }
};

const appendAttrIssues = <T>(
  path: string,
  result: ReadProseMirrorAttrsResult<T>,
  issues: ProseMirrorDocumentValidationIssue[],
): void => {
  if (result.ok) {
    return;
  }

  for (const issue of result.issues) {
    issues.push(withPathPrefix(path, issue));
  }
};

const withPathPrefix = (
  prefix: string,
  issue: ProseMirrorAttrIssue,
): ProseMirrorDocumentValidationIssue => ({
  path: `${prefix}.${issue.path}`,
  message: issue.message,
});
