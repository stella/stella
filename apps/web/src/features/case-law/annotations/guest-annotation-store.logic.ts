import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  CASE_LAW_ANNOTATION_BODY_MAX_LENGTH,
  CASE_LAW_ANNOTATION_COLORS,
  CASE_LAW_ANNOTATION_MAX_SPANS,
  CASE_LAW_ANNOTATION_QUOTE_MAX_LENGTH,
  CASE_LAW_ANNOTATION_STYLES,
  CASE_LAW_ANNOTATION_VISIBILITIES,
} from "@stll/api-contract/case-law-annotations";

import type {
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from "@/features/case-law/annotations/annotation-types";
import type { DecisionAnnotation } from "@/features/case-law/queries/annotations";
import { ClientOperationError } from "@/lib/errors/client";
import { toSafeId } from "@/lib/safe-id";
import { readStoredJson } from "@/lib/stored-json";

const GUEST_ANNOTATIONS_STORAGE_KEY = "case-law-guest-annotations:v1";
const GUEST_ANNOTATIONS_VERSION = 1;
export const GUEST_ANNOTATIONS_MAX_ITEMS = 100;

const annotationColorSchema = v.picklist(CASE_LAW_ANNOTATION_COLORS);
const annotationStyleSchema = v.picklist(CASE_LAW_ANNOTATION_STYLES);
const annotationVisibilitySchema = v.picklist(CASE_LAW_ANNOTATION_VISIBILITIES);
const uuidSchema = v.pipe(v.string(), v.uuid());
const spanSchema = v.object({
  blockAnchorId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  endOffset: v.pipe(v.number(), v.integer(), v.minValue(1)),
  quote: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(CASE_LAW_ANNOTATION_QUOTE_MAX_LENGTH),
  ),
  startOffset: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
const spansSchema = v.pipe(
  v.array(spanSchema),
  v.minLength(1),
  v.maxLength(CASE_LAW_ANNOTATION_MAX_SPANS),
);
const inputSchema = v.variant("kind", [
  v.object({
    color: annotationColorSchema,
    kind: v.literal("highlight"),
    spans: spansSchema,
    style: annotationStyleSchema,
    visibility: annotationVisibilitySchema,
  }),
  v.object({
    body: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(CASE_LAW_ANNOTATION_BODY_MAX_LENGTH),
    ),
    kind: v.literal("comment"),
    spans: spansSchema,
    visibility: annotationVisibilitySchema,
  }),
]);
const guestAnnotationSchema = v.object({
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  decisionId: uuidSchema,
  input: inputSchema,
  requestId: uuidSchema,
  rowIds: v.pipe(
    v.array(uuidSchema),
    v.minLength(1),
    v.maxLength(CASE_LAW_ANNOTATION_MAX_SPANS),
  ),
});
const guestAnnotationStoreSchema = v.object({
  items: v.pipe(
    v.array(guestAnnotationSchema),
    v.maxLength(GUEST_ANNOTATIONS_MAX_ITEMS),
  ),
  version: v.literal(GUEST_ANNOTATIONS_VERSION),
});

export type GuestAnnotation = v.InferOutput<typeof guestAnnotationSchema>;
export type GuestAnnotationStore = v.InferOutput<
  typeof guestAnnotationStoreSchema
>;

export const EMPTY_GUEST_ANNOTATION_STORE: GuestAnnotationStore = {
  items: [],
  version: GUEST_ANNOTATIONS_VERSION,
};

type GuestAnnotationStorage = Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
>;

export const readGuestAnnotationStore = (
  storage: GuestAnnotationStorage,
): GuestAnnotationStore => {
  const raw = Result.try(() => storage.getItem(GUEST_ANNOTATIONS_STORAGE_KEY));
  if (Result.isError(raw)) {
    return EMPTY_GUEST_ANNOTATION_STORE;
  }
  const parsed = readStoredJson(raw.value, guestAnnotationStoreSchema);
  if (parsed === null) {
    return EMPTY_GUEST_ANNOTATION_STORE;
  }

  return parsed.items.every(
    (item) =>
      item.rowIds.length === item.input.spans.length &&
      item.input.spans.every((span) => span.endOffset > span.startOffset),
  )
    ? parsed
    : EMPTY_GUEST_ANNOTATION_STORE;
};

export const writeGuestAnnotationStore = (
  storage: GuestAnnotationStorage,
  store: GuestAnnotationStore,
) =>
  Result.try({
    try: () =>
      storage.setItem(GUEST_ANNOTATIONS_STORAGE_KEY, JSON.stringify(store)),
    catch: (cause) =>
      new ClientOperationError({
        action: "store-guest-case-law-annotation",
        cause,
        message: "Guest annotation storage is unavailable",
      }),
  });

export const removeGuestAnnotation = (
  storage: GuestAnnotationStorage,
  requestId: string,
) => {
  const current = readGuestAnnotationStore(storage);
  const next = {
    items: current.items.filter((item) => item.requestId !== requestId),
    version: GUEST_ANNOTATIONS_VERSION,
  } as const satisfies GuestAnnotationStore;

  if (next.items.length === 0) {
    return Result.try({
      try: () => storage.removeItem(GUEST_ANNOTATIONS_STORAGE_KEY),
      catch: (cause) =>
        new ClientOperationError({
          action: "remove-guest-case-law-annotation",
          cause,
          message: "Guest annotation storage could not be cleared",
        }),
    }).map(() => next);
  }
  return writeGuestAnnotationStore(storage, next).map(() => next);
};

export const createGuestAnnotation = ({
  decisionId,
  input,
  newId,
  now,
  store,
}: {
  decisionId: string;
  input: CreateAnnotationInput;
  newId: () => string;
  now: Date;
  store: GuestAnnotationStore;
}): GuestAnnotationStore => {
  if (store.items.length >= GUEST_ANNOTATIONS_MAX_ITEMS) {
    return store;
  }
  const requestId = newId();
  const item: GuestAnnotation = {
    createdAt: now.toISOString(),
    decisionId,
    input,
    requestId,
    rowIds: input.spans.map((_, index) => (index === 0 ? requestId : newId())),
  };
  return {
    items: [...store.items, item],
    version: GUEST_ANNOTATIONS_VERSION,
  };
};

const itemHasRow = (item: GuestAnnotation, rowId: string): boolean =>
  item.rowIds.includes(rowId);

export const updateGuestAnnotation = (
  store: GuestAnnotationStore,
  update: UpdateAnnotationInput,
): GuestAnnotationStore => ({
  items: store.items.map((item) => {
    if (!itemHasRow(item, update.id)) {
      return item;
    }
    switch (update.change) {
      case "body": {
        return item.input.kind === "comment"
          ? { ...item, input: { ...item.input, body: update.body } }
          : item;
      }
      case "color": {
        return item.input.kind === "highlight"
          ? { ...item, input: { ...item.input, color: update.color } }
          : item;
      }
      case "style": {
        return item.input.kind === "highlight"
          ? { ...item, input: { ...item.input, style: update.style } }
          : item;
      }
      case "visibility": {
        return {
          ...item,
          input: { ...item.input, visibility: update.visibility },
        };
      }
      default: {
        update satisfies never;
        return panic(`Unhandled guest annotation change: ${String(update)}`);
      }
    }
  }),
  version: GUEST_ANNOTATIONS_VERSION,
});

export const deleteGuestAnnotation = (
  store: GuestAnnotationStore,
  rowId: string,
): GuestAnnotationStore => ({
  items: store.items.filter((item) => !itemHasRow(item, rowId)),
  version: GUEST_ANNOTATIONS_VERSION,
});

export const guestAnnotationRows = ({
  authorName,
  decisionId,
  store,
}: {
  authorName: string;
  decisionId: string;
  store: GuestAnnotationStore;
}): DecisionAnnotation[] =>
  store.items
    .filter((item) => item.decisionId === decisionId)
    .flatMap((item) => {
      const createdAt = new Date(item.createdAt);
      const groupId = item.rowIds.length > 1 ? item.requestId : null;
      return item.input.spans.map((span, index) => {
        const rowId = item.rowIds.at(index);
        if (rowId === undefined) {
          return panic("A validated guest annotation lost a row identifier");
        }
        return {
          authorId: "guest",
          authorImage: null,
          authorName,
          blockAnchorId: span.blockAnchorId,
          body:
            item.input.kind === "comment" && index === 0
              ? item.input.body
              : null,
          color: item.input.kind === "highlight" ? item.input.color : null,
          createdAt,
          endOffset: span.endOffset,
          groupId,
          id: toSafeId<"caseLawDecisionAnnotation">(rowId),
          kind: item.input.kind,
          mine: true,
          quote: span.quote,
          startOffset: span.startOffset,
          style: item.input.kind === "highlight" ? item.input.style : null,
          updatedAt: createdAt,
          visibility: item.input.visibility,
        };
      });
    });
