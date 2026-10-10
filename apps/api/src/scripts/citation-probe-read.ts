import { Result, TaggedError } from "better-result";

import { parseCaseLawDecisionAst } from "@stll/legal-ast/case-law-reader";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

export class CitationProbeS3ReadError extends TaggedError(
  "CitationProbeS3ReadError",
)<{
  message: string;
  status: number;
}> {}

export type AstRead =
  | { status: "usable"; ast: DocumentAst }
  | { status: "unavailable" }
  | { status: "unusable" };

export const readAst = async (
  textKey: string,
  readObject: (key: string) => Promise<string>,
): Promise<AstRead> => {
  const raw = await Result.tryPromise({
    try: async () =>
      await readObject(textKey.replace(/text\.zst$/u, "ast.json.zst")),
    catch: (cause) => cause,
  });
  if (Result.isError(raw)) {
    if (
      raw.error instanceof CitationProbeS3ReadError &&
      raw.error.status === 404
    ) {
      return { status: "unavailable" };
    }
    throw raw.error;
  }
  const ast = parseCaseLawDecisionAst(raw.value);
  return ast === null ? { status: "unusable" } : { status: "usable", ast };
};

export const hasNoUsableDocuments = (
  sampledKeys: number,
  docs: readonly { empty: boolean; unread: boolean }[],
): boolean => sampledKeys > 0 && docs.every((doc) => doc.empty || doc.unread);
