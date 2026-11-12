import * as v from "valibot";

/**
 * What the model passes `create-document`: the file name and the body in
 * `@`-directives. `workspaceId` is intentionally not here: where a draft is
 * saved is the person's choice, not something the model passes.
 */
export const createDocumentInputSchema = v.strictObject({
  name: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(256),
    v.description("Document file name (without .docx extension)"),
  ),
  source: v.pipe(
    v.string(),
    v.minLength(1),
    v.description(
      "Document body written as `@`-directives (see tool description).",
    ),
  ),
});

export type CreateDocumentInput = v.InferOutput<
  typeof createDocumentInputSchema
>;

const DOWNLOAD_EXTENSION = ".docx";
const MAX_DOWNLOAD_FILENAME_LENGTH = 255;
const UNSAFE_DOWNLOAD_FILENAME_CHARACTERS = '"/\\<>\r\n\0|*?:';

/** The `.docx` name a draft is downloaded or saved under. */
export const buildCreateDocumentDownloadFileName = (name: string): string => {
  let sanitized = "";
  for (const character of name) {
    sanitized += UNSAFE_DOWNLOAD_FILENAME_CHARACTERS.includes(character)
      ? "_"
      : character;
  }
  sanitized = sanitized.split("..").join("__");
  let firstNonDot = 0;
  while (sanitized.at(firstNonDot) === ".") {
    firstNonDot += 1;
  }
  let lastNonDot = sanitized.length;
  while (lastNonDot > firstNonDot && sanitized.at(lastNonDot - 1) === ".") {
    lastNonDot -= 1;
  }
  const safeBase =
    `${firstNonDot > 0 ? "_" : ""}${sanitized.slice(
      firstNonDot,
      lastNonDot,
    )}${lastNonDot < sanitized.length ? "_" : ""}` || "document";
  return `${safeBase.slice(
    0,
    MAX_DOWNLOAD_FILENAME_LENGTH - DOWNLOAD_EXTENSION.length,
  )}${DOWNLOAD_EXTENSION}`;
};
