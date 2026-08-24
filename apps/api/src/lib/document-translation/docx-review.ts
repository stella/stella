import { Result, TaggedError } from "better-result";
import * as slimdom from "slimdom";

import {
  applyDocxXmlPatchProposal,
  FOLIO_DOCX_CONFORMANCE_PROFILE,
  FolioDocxReviewer,
  inspectDocxPackage,
} from "@stll/folio-core/server";

import type { DocumentTranslationCommentPolicy } from "@/api/lib/document-translation/contract";
import { DOCX_MAX_ENTRY_BYTES } from "@/api/lib/docx-archive";

const COMMENTS_PART_PATH = "word/comments.xml";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

export type DocxCommentTranslationUnit = Readonly<{
  id: number;
  text: string;
}>;

export class DocxReviewError extends TaggedError("DocxReviewError")<{
  message: string;
}> {}

const runDocxOperation = async <T>(
  message: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const result = await Result.tryPromise({
    try: operation,
    catch: () => new DocxReviewError({ message }),
  });
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

const openReviewer = async (buffer: ArrayBuffer): Promise<FolioDocxReviewer> =>
  await runDocxOperation(
    "Could not parse the DOCX review structure",
    async () => await FolioDocxReviewer.fromBuffer(buffer),
  );

const flattenComments = (
  reviewer: FolioDocxReviewer,
): DocxCommentTranslationUnit[] => {
  const units: DocxCommentTranslationUnit[] = [];
  for (const comment of reviewer.getComments()) {
    units.push({ id: comment.id, text: comment.text });
    units.push(
      ...comment.replies.map((reply) => ({ id: reply.id, text: reply.text })),
    );
  }
  return units;
};

export const inspectDocxComments = async (
  buffer: ArrayBuffer,
): Promise<{ hasComments: boolean }> => {
  const reviewer = await openReviewer(buffer);
  return { hasComments: flattenComments(reviewer).length > 0 };
};

/** Resolve tracked revisions in every editable Word story to the Final view. */
export const resolveDocxToFinal = async (
  buffer: ArrayBuffer,
): Promise<ArrayBuffer> => {
  const reviewer = await openReviewer(buffer);
  for (const { handle } of reviewer.listStories()) {
    if (!reviewer.resolveReviewedStory({ story: handle, view: "final" })) {
      throw new DocxReviewError({
        message: `Could not resolve ${handle.type} story to its final view`,
      });
    }
  }
  const output = await runDocxOperation(
    "Could not persist the DOCX Final view",
    async () => await reviewer.toBuffer(),
  );
  await assertCommentAnchorsPreserved(buffer, output);
  const persisted = await openReviewer(output);
  for (const { handle } of persisted.listStories()) {
    const story = persisted.readReviewedStory({
      story: handle,
      view: "current-markup",
    });
    if (story && story.changes.length > 0) {
      throw new DocxReviewError({
        message: `Final view did not persist for ${handle.type} story`,
      });
    }
  }
  return output;
};

export const readDocxCommentTranslationUnits = async (
  buffer: ArrayBuffer,
): Promise<DocxCommentTranslationUnit[]> =>
  flattenComments(await openReviewer(buffer));

const equalIds = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right.at(index));

const assertCommentAnchorsPreserved = async (
  source: ArrayBuffer,
  output: ArrayBuffer,
): Promise<void> => {
  const [sourceReviewer, outputReviewer] = await Promise.all([
    openReviewer(source),
    openReviewer(output),
  ]);
  const outputById = new Map(
    outputReviewer.getComments().map((comment) => [comment.id, comment]),
  );
  for (const sourceComment of sourceReviewer.getComments()) {
    const outputComment = outputById.get(sourceComment.id);
    if (!outputComment) {
      throw new DocxReviewError({
        message: `Output is missing comment ${sourceComment.id}`,
      });
    }
    if (sourceComment.blockId !== null && outputComment.blockId === null) {
      throw new DocxReviewError({
        message: `Output lost the anchor for comment ${sourceComment.id}`,
      });
    }
  }
};

type ParsedCommentsPart = {
  commentsById: ReadonlyMap<number, slimdom.Element>;
  document: slimdom.Document;
  namespace: string;
  prefix: string | null;
};

const parseCommentsPart = (xml: string): ParsedCommentsPart => {
  let document: slimdom.Document;
  try {
    document = slimdom.parseXmlDocument(xml);
  } catch {
    throw new DocxReviewError({
      message: `Could not parse ${COMMENTS_PART_PATH}`,
    });
  }
  const root = document.documentElement;
  const namespace = root?.namespaceURI;
  if (!root || !namespace || root.localName !== "comments") {
    throw new DocxReviewError({
      message: `${COMMENTS_PART_PATH} does not contain a Word comments root`,
    });
  }
  const commentsById = new Map<number, slimdom.Element>();
  for (const comment of root.getElementsByTagNameNS(namespace, "comment")) {
    const rawId =
      comment.getAttributeNS(namespace, "id") ?? comment.getAttribute("w:id");
    const id = rawId === null ? Number.NaN : Number.parseInt(rawId, 10);
    if (!Number.isSafeInteger(id) || commentsById.has(id)) {
      throw new DocxReviewError({
        message: `${COMMENTS_PART_PATH} contains a missing or duplicate comment ID`,
      });
    }
    commentsById.set(id, comment);
  }
  return {
    commentsById,
    document,
    namespace,
    prefix: root.prefix,
  };
};

const qualifiedName = (prefix: string | null, localName: string): string =>
  prefix ? `${prefix}:${localName}` : localName;

const createCommentParagraphs = (
  part: ParsedCommentsPart,
  text: string,
): slimdom.Element[] =>
  text.split("\n").map((line) => {
    const paragraph = part.document.createElementNS(
      part.namespace,
      qualifiedName(part.prefix, "p"),
    );
    const run = part.document.createElementNS(
      part.namespace,
      qualifiedName(part.prefix, "r"),
    );
    const textNode = part.document.createElementNS(
      part.namespace,
      qualifiedName(part.prefix, "t"),
    );
    textNode.setAttributeNS(XML_NAMESPACE, "xml:space", "preserve");
    textNode.textContent = line;
    run.append(textNode);
    paragraph.append(run);
    return paragraph;
  });

const replaceCommentContent = (
  comment: slimdom.Element,
  content: readonly slimdom.Element[],
): void => {
  comment.textContent = "";
  comment.append(...content);
};

type ApplyDocxCommentPolicyOptions = {
  source: ArrayBuffer;
  output: ArrayBuffer;
  policy: DocumentTranslationCommentPolicy;
  translations: ReadonlyMap<number, string>;
};

const inspectCommentsPart = async (
  buffer: ArrayBuffer,
): Promise<{ sha256: string; text: string }> => {
  const inspection = await runDocxOperation(
    "Could not inspect the DOCX comments part",
    async () =>
      await inspectDocxPackage(buffer, {
        xmlParts: [COMMENTS_PART_PATH],
        limits: {
          maxXmlPartBytes: DOCX_MAX_ENTRY_BYTES,
          maxXmlTotalBytes: DOCX_MAX_ENTRY_BYTES,
        },
      }),
  );
  const part = inspection.xmlParts.at(0);
  if (!part || part.path !== COMMENTS_PART_PATH) {
    throw new DocxReviewError({
      message: `The document is missing ${COMMENTS_PART_PATH}`,
    });
  }
  return part;
};

/** Restore source comment metadata and apply the user's selected text policy. */
export const applyDocxCommentPolicy = async ({
  source,
  output,
  policy,
  translations,
}: ApplyDocxCommentPolicyOptions): Promise<ArrayBuffer> => {
  await assertCommentAnchorsPreserved(source, output);
  const [sourcePartInspection, outputPartInspection] = await Promise.all([
    inspectCommentsPart(source),
    inspectCommentsPart(output),
  ]);
  const sourceXml = sourcePartInspection.text;
  const outputXml = outputPartInspection.text;
  const sourcePart = parseCommentsPart(sourceXml);
  const outputPart = parseCommentsPart(outputXml);
  const sourceIds = [...sourcePart.commentsById.keys()].toSorted(
    (left, right) => left - right,
  );
  const outputIds = [...outputPart.commentsById.keys()].toSorted(
    (left, right) => left - right,
  );
  if (!equalIds(sourceIds, outputIds)) {
    throw new DocxReviewError({
      message: "The translated document changed the comment thread structure",
    });
  }

  for (const [id, comment] of sourcePart.commentsById) {
    if (policy === "original") {
      continue;
    }
    const translation = translations.get(id);
    if (translation === undefined) {
      throw new DocxReviewError({
        message: `Translation is missing for comment ${id}`,
      });
    }
    const translatedContent = createCommentParagraphs(sourcePart, translation);
    if (policy === "translated") {
      replaceCommentContent(comment, translatedContent);
      continue;
    }
    comment.append(...translatedContent);
  }
  const commentsXml =
    policy === "original"
      ? sourceXml
      : slimdom.serializeToWellFormedString(sourcePart.document);
  const application = await runDocxOperation(
    "Could not apply the DOCX comment policy",
    async () =>
      await applyDocxXmlPatchProposal({
        bytes: output,
        proposal: {
          version: 1,
          replacements: [
            {
              path: COMMENTS_PART_PATH,
              baseSha256: outputPartInspection.sha256,
              replacementXml: commentsXml,
            },
          ],
        },
        allowedParts: [COMMENTS_PART_PATH],
        validationProfile: FOLIO_DOCX_CONFORMANCE_PROFILE,
        limits: {
          maxPartBytes: DOCX_MAX_ENTRY_BYTES,
          maxTotalBytes: DOCX_MAX_ENTRY_BYTES,
        },
      }),
  );
  if (application.status !== "applied") {
    throw new DocxReviewError({
      message: `The comment update failed package validation (${application.status})`,
    });
  }
  const patchedBytes = new Uint8Array(application.bytes.byteLength);
  patchedBytes.set(application.bytes);
  const patched = patchedBytes.buffer;
  await assertCommentAnchorsPreserved(source, patched);
  return patched;
};
