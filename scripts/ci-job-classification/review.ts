import { TaggedError } from "better-result";

import type { CLASSIFICATIONS } from "./classification-values";
import type { JobShape, ParsedDocument } from "./yaml";

type PrivilegedJobOptions = {
  kind: (typeof CLASSIFICATIONS)[number] | undefined;
  shape: JobShape;
};
// Inspect the parser's projected shape, including secret references and run markers.
const hasPrivilege = (value: unknown): boolean => {
  if (typeof value === "string") {
    return /secrets(?:\.|\[)|publish|deploy|release|self-hosted/iu.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(hasPrivilege);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.entries(value).some(([key, child]) => {
    if (key === "publication-command" && child === true) {
      return true;
    }
    if (key === "secrets" && child !== null) {
      return true;
    }
    if (key === "permissions") {
      return (
        child === "write-all" ||
        (typeof child === "object" &&
          child !== null &&
          Object.values(child).includes("write"))
      );
    }
    return hasPrivilege(child);
  });
};
export const isPrivilegedJob = ({ kind, shape }: PrivilegedJobOptions) =>
  kind === "priority" ||
  hasPrivilege(shape.document) ||
  hasPrivilege(shape.job);

// Repository writes: contents write permission, an app token that requests
// it, or the shared signed-commit action. Such a job publishes commits, tags
// or pull-request branches, so it is classified `priority`, never a check.
// Pull-request write alone (labels, comments, auto-merge) publishes nothing.
const SIGNED_COMMIT_ACTION = /(?:^|\/)actions\/signed-commit@/u;
const writesRepository = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(writesRepository);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.entries(value).some(([key, child]) => {
    if (key === "permissions") {
      return (
        child === "write-all" ||
        (typeof child === "object" &&
          child !== null &&
          "contents" in child &&
          child.contents === "write")
      );
    }
    if (key === "permission-contents" && child === "write") {
      return true;
    }
    if (
      key === "uses" &&
      typeof child === "string" &&
      SIGNED_COMMIT_ACTION.test(child)
    ) {
      return true;
    }
    return writesRepository(child);
  });
};

type WritingJobOptions = {
  shape: JobShape;
  reachableDocuments: Iterable<ParsedDocument>;
};
export const isRepositoryWritingJob = ({
  shape,
  reachableDocuments,
}: WritingJobOptions) =>
  writesRepository(shape.document) ||
  writesRepository(shape.job) ||
  [...reachableDocuments].some(writesRepository);

type PrivilegedJobClosureOptions = PrivilegedJobOptions & {
  reachableDocuments: Iterable<ParsedDocument>;
};
export const isPrivilegedJobClosure = ({
  kind,
  shape,
  reachableDocuments,
}: PrivilegedJobClosureOptions) =>
  isPrivilegedJob({ kind, shape }) ||
  [...reachableDocuments].some((document) => document.privileged);

export class ReviewRequiredError extends TaggedError("ReviewRequiredError")<{
  message: string;
  privilegedJobs: string[];
}> {}
