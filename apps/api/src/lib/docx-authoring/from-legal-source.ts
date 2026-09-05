import { Result, TaggedError } from "better-result";

import { compileLegalSourceToDocx } from "@stll/docx-core";
import type {
  LegalDraftDiagnostic,
  LegalSourceCompileOptions,
} from "@stll/docx-core";

/** The draft's structure must be repaired before it can compile. */
export class LegalSourceCompileError extends TaggedError(
  "LegalSourceCompileError",
)<{
  message: string;
  diagnostics: readonly LegalDraftDiagnostic[];
}> {}

/**
 * Compile a draft written in stella's legal-source markup (GFM plus the
 * `@title`, `@clause`, `@schedule`, and `@signatures` directives) to DOCX.
 * The compiler derives numbering and structure from the directives, so it
 * is the wrong entry point for plain Markdown: that is `markdownToStellaDocx`.
 */
export const legalSourceToDocx = async (
  source: string,
  options: LegalSourceCompileOptions,
): Promise<Result<Buffer, LegalSourceCompileError>> => {
  const compiled = await compileLegalSourceToDocx(source, options);
  if (compiled.status !== "ok") {
    return Result.err(
      new LegalSourceCompileError({
        message: compiled.errors.map((error) => error.message).join("; "),
        diagnostics: compiled.errors,
      }),
    );
  }
  return Result.ok(compiled.buffer);
};
