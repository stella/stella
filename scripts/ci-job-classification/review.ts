import { TaggedError } from "better-result";

import type { CLASSIFICATIONS } from "./classification-values";
import type { JobShape, ParsedDocument } from "./yaml";

type PrivilegedJobOptions = {
  kind: (typeof CLASSIFICATIONS)[number] | undefined;
  privileged: boolean;
  shape: JobShape;
};
export const isPrivilegedJob = ({ kind, privileged }: PrivilegedJobOptions) =>
  kind === "priority" || privileged;

// Repository writes: contents write permission, an app token that requests
// it, or the shared signed-commit action. Such a job publishes commits, tags
// or pull-request branches, so it is classified `priority`, never a check.
// Pull-request write alone (labels, comments, auto-merge) publishes nothing.
const SIGNED_COMMIT_ACTION = /(?:^|\/)actions\/signed-commit@/u;
const grantsContentsWrite = (permissions: unknown) =>
  permissions === "write-all" ||
  (typeof permissions === "object" &&
    permissions !== null &&
    "contents" in permissions &&
    permissions.contents === "write");

// Steps and inputs that write regardless of the job token: an app token that
// requests contents write, or the signed-commit action. Permission blocks are
// resolved per job instead, since a job's own block replaces the workflow's.
export const requestsRepositoryWrite = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(requestsRepositoryWrite);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.entries(value).some(([key, child]) => {
    if (key === "permissions") {
      return false;
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
    return requestsRepositoryWrite(child);
  });
};

export const shapeWritesRepository = ({ document, job }: JobShape) =>
  grantsContentsWrite(
    "permissions" in job ? job["permissions"] : document["permissions"],
  ) || requestsRepositoryWrite(job);

type WritingJobOptions = {
  shape: JobShape;
  reachableDocuments: Iterable<ParsedDocument>;
};
export const isRepositoryWritingJob = ({
  shape,
  reachableDocuments,
}: WritingJobOptions) =>
  shapeWritesRepository(shape) ||
  [...reachableDocuments].some((document) => document.writesRepository);

type PrivilegedJobClosureOptions = PrivilegedJobOptions & {
  reachableDocuments: Iterable<ParsedDocument>;
};
export const isPrivilegedJobClosure = ({
  kind,
  privileged,
  shape,
  reachableDocuments,
}: PrivilegedJobClosureOptions) =>
  isPrivilegedJob({ kind, privileged, shape }) ||
  [...reachableDocuments].some((document) => document.privileged);

export class ReviewRequiredError extends TaggedError("ReviewRequiredError")<{
  message: string;
  privilegedJobs: string[];
}> {}
