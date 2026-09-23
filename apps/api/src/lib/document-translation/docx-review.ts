import { Result, TaggedError } from "better-result";
import * as slimdom from "slimdom";

import {
  applyDocxXmlPatchProposal,
  FOLIO_DOCX_CONFORMANCE_PROFILE,
  FolioDocxReviewer,
  inspectDocxPackage,
  type FolioReviewComment,
  type FolioReviewCommentReply,
} from "@stll/folio-core/server";

import type { DocumentTranslationCommentPolicy } from "@/api/lib/document-translation/contract";
import { DOCX_MAX_ENTRY_BYTES } from "@/api/lib/docx-archive";
import { derivedScannedFile } from "@/api/lib/file-scan/document-parsers";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";

// This module owns its folio parses: its exports take a `ScannedFile`, and the
// other parses re-read its own serializer output to verify it
// (`scanned-file-boundary` lists it as an owner).

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
): Promise<Result<T, DocxReviewError>> =>
  await Result.tryPromise({
    try: operation,
    catch: () => new DocxReviewError({ message }),
  });

const openReviewer = async (
  buffer: ArrayBuffer,
): Promise<Result<FolioDocxReviewer, DocxReviewError>> =>
  await runDocxOperation(
    "Could not parse the DOCX review structure",
    async () => await FolioDocxReviewer.fromBuffer(buffer),
  );

type ReviewerPair = {
  sourceReviewer: FolioDocxReviewer;
  outputReviewer: FolioDocxReviewer;
};

// Both documents parse concurrently; a source failure is reported first.
const openReviewerPair = async (
  source: ArrayBuffer,
  output: ArrayBuffer,
): Promise<Result<ReviewerPair, DocxReviewError>> => {
  const [sourceReviewer, outputReviewer] = await Promise.all([
    openReviewer(source),
    openReviewer(output),
  ]);
  return Result.gen(function* () {
    return Result.ok({
      sourceReviewer: yield* sourceReviewer,
      outputReviewer: yield* outputReviewer,
    });
  });
};

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

const projectReplyMetadata = (reply: FolioReviewCommentReply) =>
  ({
    id: reply.id,
    author: reply.author,
    date: reply.date,
    text: null,
  }) satisfies Record<keyof FolioReviewCommentReply, unknown>;

const projectCommentMetadata = (comment: FolioReviewComment) =>
  ({
    id: comment.id,
    author: comment.author,
    date: comment.date,
    text: null,
    anchoredText: null,
    blockId: null,
    replies: comment.replies
      .toSorted((left, right) => left.id - right.id)
      .map(projectReplyMetadata),
    done: comment.done,
  }) satisfies Record<keyof FolioReviewComment, unknown>;

const serializedCommentMetadata = (reviewer: FolioDocxReviewer): string =>
  JSON.stringify(
    reviewer
      .getComments()
      .toSorted((left, right) => left.id - right.id)
      .map(projectCommentMetadata),
  );

const checkCommentMetadataPreserved = async (
  source: ArrayBuffer,
  output: ArrayBuffer,
): Promise<Result<void, DocxReviewError>> =>
  (await openReviewerPair(source, output)).andThen(
    ({ sourceReviewer, outputReviewer }) =>
      serializedCommentMetadata(sourceReviewer) ===
      serializedCommentMetadata(outputReviewer)
        ? Result.ok()
        : Result.err(
            new DocxReviewError({
              message:
                "The translated document changed comment metadata or threading",
            }),
          ),
  );

export const inspectDocxComments = async (
  file: ScannedFile,
): Promise<Result<{ hasComments: boolean }, DocxReviewError>> =>
  (await openReviewer(file.bytes)).map((reviewer) => ({
    hasComments: flattenComments(reviewer).length > 0,
  }));

/** Resolve tracked revisions in every editable Word story to the Final view. */
export const resolveDocxToFinal = async (
  file: ScannedFile,
): Promise<Result<ScannedFile, DocxReviewError>> =>
  await Result.gen(async function* () {
    const buffer = file.bytes;
    const reviewer = yield* Result.await(openReviewer(buffer));
    for (const { handle } of reviewer.listStories()) {
      if (!reviewer.resolveReviewedStory({ story: handle, view: "final" })) {
        return Result.err(
          new DocxReviewError({
            message: `Could not resolve ${handle.type} story to its final view`,
          }),
        );
      }
    }
    const output = yield* Result.await(
      runDocxOperation(
        "Could not persist the DOCX Final view",
        async () => await reviewer.toBuffer(),
      ),
    );
    yield* Result.await(checkCommentAnchorsPreserved(buffer, output));
    const persisted = yield* Result.await(openReviewer(output));
    for (const { handle } of persisted.listStories()) {
      const story = persisted.readReviewedStory({
        story: handle,
        view: "current-markup",
      });
      if (story && story.changes.length > 0) {
        return Result.err(
          new DocxReviewError({
            message: `Final view did not persist for ${handle.type} story`,
          }),
        );
      }
    }
    return Result.ok(derivedScannedFile(file, output));
  });

export const readDocxCommentTranslationUnits = async (
  file: ScannedFile,
): Promise<Result<DocxCommentTranslationUnit[], DocxReviewError>> =>
  (await openReviewer(file.bytes)).map(flattenComments);

const equalIds = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right.at(index));

const checkCommentAnchorsPreserved = async (
  source: ArrayBuffer,
  output: ArrayBuffer,
): Promise<Result<void, DocxReviewError>> =>
  (await openReviewerPair(source, output)).andThen(
    ({ sourceReviewer, outputReviewer }) => {
      const outputById = new Map(
        outputReviewer.getComments().map((comment) => [comment.id, comment]),
      );
      for (const sourceComment of sourceReviewer.getComments()) {
        const outputComment = outputById.get(sourceComment.id);
        if (!outputComment) {
          return Result.err(
            new DocxReviewError({
              message: `Output is missing comment ${sourceComment.id}`,
            }),
          );
        }
        if (sourceComment.blockId !== null && outputComment.blockId === null) {
          return Result.err(
            new DocxReviewError({
              message: `Output lost the anchor for comment ${sourceComment.id}`,
            }),
          );
        }
      }
      return Result.ok();
    },
  );

type ParsedCommentsPart = {
  commentsById: ReadonlyMap<number, slimdom.Element>;
  document: slimdom.Document;
  namespace: string;
  prefix: string | null;
};

const parseCommentsPart = (
  xml: string,
): Result<ParsedCommentsPart, DocxReviewError> => {
  const parsed = Result.try({
    try: () => slimdom.parseXmlDocument(xml),
    catch: () =>
      new DocxReviewError({
        message: `Could not parse ${COMMENTS_PART_PATH}`,
      }),
  });
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  const document = parsed.value;
  const root = document.documentElement;
  const namespace = root?.namespaceURI;
  if (!root || !namespace || root.localName !== "comments") {
    return Result.err(
      new DocxReviewError({
        message: `${COMMENTS_PART_PATH} does not contain a Word comments root`,
      }),
    );
  }
  const commentsById = new Map<number, slimdom.Element>();
  for (const comment of root.getElementsByTagNameNS(namespace, "comment")) {
    const rawId =
      comment.getAttributeNS(namespace, "id") ?? comment.getAttribute("w:id");
    const id = rawId === null ? Number.NaN : Number.parseInt(rawId, 10);
    if (!Number.isSafeInteger(id) || commentsById.has(id)) {
      return Result.err(
        new DocxReviewError({
          message: `${COMMENTS_PART_PATH} contains a missing or duplicate comment ID`,
        }),
      );
    }
    commentsById.set(id, comment);
  }
  return Result.ok({
    commentsById,
    document,
    namespace,
    prefix: root.prefix,
  });
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

const directCommentParagraphs = (
  comment: slimdom.Element,
  namespace: string,
): slimdom.Element[] => {
  const paragraphs: slimdom.Element[] = [];
  for (
    let child = comment.firstElementChild;
    child !== null;
    child = child.nextElementSibling
  ) {
    if (child.namespaceURI === namespace && child.localName === "p") {
      paragraphs.push(child);
    }
  }
  return paragraphs;
};

const transferLastParagraphIds = (
  part: ParsedCommentsPart,
  comment: slimdom.Element,
  translatedContent: readonly slimdom.Element[],
): void => {
  const sourceParagraph = directCommentParagraphs(comment, part.namespace).at(
    -1,
  );
  const targetParagraph = translatedContent.at(-1);
  if (!sourceParagraph || !targetParagraph) {
    return;
  }
  const paraIdAttributes: slimdom.Attr[] = [];
  for (const attribute of sourceParagraph.attributes) {
    if (attribute.localName === "paraId") {
      paraIdAttributes.push(attribute);
    }
  }
  for (const attribute of paraIdAttributes) {
    sourceParagraph.removeAttributeNS(
      attribute.namespaceURI,
      attribute.localName,
    );
    targetParagraph.setAttributeNS(
      attribute.namespaceURI,
      attribute.name,
      attribute.value,
    );
  }
};

const replaceCommentContent = (
  comment: slimdom.Element,
  content: readonly slimdom.Element[],
): void => {
  comment.textContent = "";
  comment.append(...content);
};

type ApplyDocxCommentPolicyOptions = {
  source: ScannedFile;
  output: ScannedFile;
  policy: DocumentTranslationCommentPolicy;
  translations: ReadonlyMap<number, string>;
};

const inspectCommentsPart = async (
  buffer: ArrayBuffer,
): Promise<Result<{ sha256: string; text: string }, DocxReviewError>> =>
  (
    await runDocxOperation(
      "Could not inspect the DOCX comments part",
      async () =>
        await inspectDocxPackage(buffer, {
          xmlParts: [COMMENTS_PART_PATH],
          limits: {
            maxXmlPartBytes: DOCX_MAX_ENTRY_BYTES,
            maxXmlTotalBytes: DOCX_MAX_ENTRY_BYTES,
          },
        }),
    )
  ).andThen((inspection) => {
    const part = inspection.xmlParts.at(0);
    if (!part || part.path !== COMMENTS_PART_PATH) {
      return Result.err(
        new DocxReviewError({
          message: `The document is missing ${COMMENTS_PART_PATH}`,
        }),
      );
    }
    return Result.ok(part);
  });

/** Restore source comment metadata and apply the user's selected text policy. */
export const applyDocxCommentPolicy = async ({
  source: sourceFile,
  output: outputFile,
  policy,
  translations,
}: ApplyDocxCommentPolicyOptions): Promise<
  Result<ArrayBuffer, DocxReviewError>
> =>
  await Result.gen(async function* () {
    const source = sourceFile.bytes;
    const output = outputFile.bytes;
    yield* Result.await(checkCommentAnchorsPreserved(source, output));
    const [sourcePartInspection, outputPartInspection] = await Promise.all([
      inspectCommentsPart(source),
      inspectCommentsPart(output),
    ]);
    const sourceXml = (yield* sourcePartInspection).text;
    const outputInspection = yield* outputPartInspection;
    const outputXml = outputInspection.text;
    const sourcePart = yield* parseCommentsPart(sourceXml);
    const outputPart = yield* parseCommentsPart(outputXml);
    const sourceIds = [...sourcePart.commentsById.keys()].toSorted(
      (left, right) => left - right,
    );
    const outputIds = [...outputPart.commentsById.keys()].toSorted(
      (left, right) => left - right,
    );
    if (!equalIds(sourceIds, outputIds)) {
      return Result.err(
        new DocxReviewError({
          message:
            "The translated document changed the comment thread structure",
        }),
      );
    }

    for (const [id, comment] of sourcePart.commentsById) {
      if (policy === "original") {
        continue;
      }
      const translation = translations.get(id);
      if (translation === undefined) {
        return Result.err(
          new DocxReviewError({
            message: `Translation is missing for comment ${id}`,
          }),
        );
      }
      const translatedContent = createCommentParagraphs(
        sourcePart,
        translation,
      );
      transferLastParagraphIds(sourcePart, comment, translatedContent);
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
    const application = yield* Result.await(
      runDocxOperation(
        "Could not apply the DOCX comment policy",
        async () =>
          await applyDocxXmlPatchProposal({
            bytes: output,
            proposal: {
              version: 1,
              replacements: [
                {
                  path: COMMENTS_PART_PATH,
                  baseSha256: outputInspection.sha256,
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
      ),
    );
    if (application.status !== "applied") {
      return Result.err(
        new DocxReviewError({
          message: `The comment update failed package validation (${application.status})`,
        }),
      );
    }
    const patchedBytes = new Uint8Array(application.bytes.byteLength);
    patchedBytes.set(application.bytes);
    const patched = patchedBytes.buffer;
    yield* Result.await(checkCommentAnchorsPreserved(source, patched));
    yield* Result.await(checkCommentMetadataPreserved(source, patched));
    return Result.ok(patched);
  });
