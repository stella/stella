// parser-output-unchanged: Collection part validation and immutable payload encoding retain source extraction and document AST contents.
import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { documentAstSchema, hasUsableAst } from "@stll/legal-ast/document-ast";

import { LIMITS } from "@/api/lib/limits";
import { sortDeep } from "@/api/lib/sort-deep";

import type { CorpusPayload } from "./corpus-content-hash";
import { payloadCarriesDocument } from "./corpus-content-hash";
import {
  emptyAstSchema,
  persistedDecisionSectionsSchema,
} from "./document-types";

export const COLLECTION_DOCUMENT_EXTENT = {
  SECTION: "section",
  COMPLETE: "complete",
  UNCLASSIFIED: "unclassified",
} as const;
export const COLLECTION_DOCUMENT_BODY_CONTENT_TYPE =
  "application/vnd.stella.collection-document-body+json";
const COLLECTION_DOCUMENT_BODY_MAX_BYTES =
  LIMITS.corpusPayloadMaxDecompressedBytes;

const ordinal = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
const blockOffset = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
const common = {
  legalSentence: v.nullable(
    v.pipe(v.string(), v.maxLength(COLLECTION_DOCUMENT_BODY_MAX_BYTES)),
  ),
  keywords: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(1024))),
    v.maxLength(128),
  ),
};

/** Publisher order is its printed section number, never the crawl's discovery order. */
export const collectionDocumentPartSchema = v.variant("extent", [
  v.object({
    extent: v.literal(COLLECTION_DOCUMENT_EXTENT.SECTION),
    sectionNumber: ordinal,
    firstBlock: blockOffset,
    afterLastBlock: ordinal,
    collectionLabel: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    ...common,
  }),
  v.object({
    extent: v.literal(COLLECTION_DOCUMENT_EXTENT.COMPLETE),
    ...common,
  }),
  v.object({
    extent: v.literal(COLLECTION_DOCUMENT_EXTENT.UNCLASSIFIED),
    ...common,
  }),
]);
export type CollectionDocumentPart = v.InferOutput<
  typeof collectionDocumentPartSchema
>;

/** Normal corpus fields, retained whole so readers can compose common context once. */
const collectionDocumentBodySchema = v.object({
  text: v.nullable(
    v.pipe(v.string(), v.maxLength(COLLECTION_DOCUMENT_BODY_MAX_BYTES)),
  ),
  sections: persistedDecisionSectionsSchema,
  ast: v.nullable(v.union([documentAstSchema, emptyAstSchema])),
});

class CollectionDocumentPartInvalid extends TaggedError(
  "CollectionDocumentPartInvalid",
)<{ message: string }> {}

export const validateCollectionDocumentPart = (
  part: CollectionDocumentPart,
  payload: CorpusPayload,
): Result<CollectionDocumentPart, CollectionDocumentPartInvalid> => {
  const parsed = v.safeParse(collectionDocumentPartSchema, part);
  if (!parsed.success) {
    return Result.err(
      new CollectionDocumentPartInvalid({
        message:
          "Collection document part exceeds its canonical descriptor bounds",
      }),
    );
  }
  switch (parsed.output.extent) {
    case COLLECTION_DOCUMENT_EXTENT.UNCLASSIFIED:
      return Result.ok(parsed.output);
    case COLLECTION_DOCUMENT_EXTENT.COMPLETE:
      return payloadCarriesDocument(payload)
        ? Result.ok(parsed.output)
        : Result.err(
            new CollectionDocumentPartInvalid({
              message:
                "A complete collection edition requires retained document content",
            }),
          );
    case COLLECTION_DOCUMENT_EXTENT.SECTION:
      if (
        !hasUsableAst(payload.ast) ||
        parsed.output.firstBlock >= parsed.output.afterLastBlock ||
        parsed.output.afterLastBlock > payload.ast.blocks.length
      ) {
        return Result.err(
          new CollectionDocumentPartInvalid({
            message:
              "Collection section offsets must select a nonempty range of the retained AST",
          }),
        );
      }
      return Result.ok(parsed.output);
  }
};

/** Stable bytes make repeated observations share their immutable owned payload. */
export const encodeCollectionDocumentBody = (payload: CorpusPayload) => {
  const encoded = JSON.stringify(sortDeep(payload));
  const bytes = new TextEncoder().encode(encoded);
  return bytes.byteLength <= COLLECTION_DOCUMENT_BODY_MAX_BYTES
    ? Result.ok(bytes)
    : Result.err(
        new CollectionDocumentPartInvalid({
          message: "Collection document body exceeds the corpus payload budget",
        }),
      );
};

export const decodeCollectionDocumentBody = (bytes: Uint8Array) => {
  if (bytes.byteLength > COLLECTION_DOCUMENT_BODY_MAX_BYTES) {
    return Result.err(
      new CollectionDocumentPartInvalid({
        message: "Collection document body exceeds the corpus payload budget",
      }),
    );
  }
  const decoded = Result.try({
    try: (): unknown =>
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    catch: () =>
      new CollectionDocumentPartInvalid({
        message: "Collection document body is not readable UTF-8 JSON",
      }),
  });
  if (Result.isError(decoded)) {
    return decoded;
  }
  const parsed = v.safeParse(collectionDocumentBodySchema, decoded.value);
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err(
        new CollectionDocumentPartInvalid({
          message:
            "Collection document body does not match the corpus payload contract",
        }),
      );
};
