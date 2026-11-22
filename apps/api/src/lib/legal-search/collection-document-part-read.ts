import * as v from "valibot";

import { collectionDocumentPartSchema } from "./collection-document-part";

const [first, second, third, ...additional] =
  collectionDocumentPartSchema.options;
// A new source variant must participate in the read projection too.
additional satisfies readonly [];

/** Composition needs boundaries and actual keywords, not corpus-sized headnotes. */
export const collectionDocumentPartReadSchema = v.variant("extent", [
  v.omit(first, ["legalSentence"]),
  v.omit(second, ["legalSentence"]),
  v.omit(third, ["legalSentence"]),
]);

export type CollectionDocumentPartRead = v.InferOutput<
  typeof collectionDocumentPartReadSchema
>;
