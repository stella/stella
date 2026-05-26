import { validateDocumentModel } from "@stll/docx-core";
import type {
  ValidateDocumentModelIssue,
  ValidateDocumentModelResult,
} from "@stll/docx-core";

import type { Document } from "../types/document";

export class DocxModelValidationError extends Error {
  readonly issues: ValidateDocumentModelIssue[];

  constructor(context: string, issues: ValidateDocumentModelIssue[]) {
    super(`${context}:\n${formatDocumentModelIssues(issues).join("\n")}`);
    this.name = "DocxModelValidationError";
    this.issues = issues;
  }
}

export const validateFolioDocumentModel = (
  document: Document,
): ValidateDocumentModelResult => validateDocumentModel(document);

export const assertValidFolioDocumentModel = (
  document: Document,
  context: string,
): void => {
  const validation = validateFolioDocumentModel(document);
  if (validation.valid) {
    return;
  }

  throw new DocxModelValidationError(context, validation.issues);
};

export const formatDocumentModelIssues = (
  issues: ValidateDocumentModelIssue[],
): string[] =>
  issues.map((issue) => {
    const prefix =
      issue.severity === "warning" ? "DOCX model warning" : "DOCX model error";
    return `${prefix} at ${issue.path}: ${issue.message}`;
  });
