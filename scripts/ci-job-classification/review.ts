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
