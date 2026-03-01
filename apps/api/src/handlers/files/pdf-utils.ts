import { PDF } from "@libpdf/core";
import { Result, TaggedError } from "better-result";

export class CorruptedPdfError extends TaggedError("CorruptedPdfError")<{
  message: string;
  cause: unknown;
}>() {}

export const isEncryptedPdf = async (buffer: ArrayBuffer) => {
  const result = await Result.tryPromise({
    try: async () => {
      const pdf = await PDF.load(new Uint8Array(buffer));
      return pdf.isEncrypted;
    },
    catch: (error) =>
      new CorruptedPdfError({
        message: "Failed to parse PDF",
        cause: error,
      }),
  });

  return result;
};
