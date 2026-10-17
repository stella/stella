import { panic } from "better-result";
import * as v from "valibot";

import {
  READER_ANNOTATION_BODY_MAX_LENGTH,
  READER_ANNOTATION_COLORS,
  READER_ANNOTATION_MAX_SPANS,
  READER_ANNOTATION_QUOTE_MAX_LENGTH,
  READER_ANNOTATION_STYLES,
  READER_ANNOTATION_TARGET_TYPES,
  READER_ANNOTATION_VISIBILITIES,
} from "@stll/api-contract/legal-reader-annotations";

import type {
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from "@/components/legal-reader/annotations/annotation-types";
import type { ReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotations-query";
import { ClientOperationError } from "@/lib/errors/client";
import {
  definePersistedState,
  keepInAnyScope,
  readPersistedState,
  removePersistedState,
  writePersistedState,
} from "@/lib/persisted-state/registry";
import { toSafeId } from "@/lib/safe-id";

const GUEST_ANNOTATIONS_STORAGE_KEY = "legal-reader-guest-annotations:v2";
const GUEST_ANNOTATIONS_VERSION = 2;
export const GUEST_ANNOTATIONS_MAX_ITEMS = 100;

const annotationColorSchema = v.picklist(READER_ANNOTATION_COLORS);
const annotationStyleSchema = v.picklist(READER_ANNOTATION_STYLES);
const annotationVisibilitySchema = v.picklist(READER_ANNOTATION_VISIBILITIES);
const annotationTargetTypeSchema = v.picklist(READER_ANNOTATION_TARGET_TYPES);
const uuidSchema = v.pipe(v.string(), v.uuid());
const spanSchema = v.object({
  blockAnchorId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  endOffset: v.pipe(v.number(), v.integer(), v.minValue(1)),
  quote: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(READER_ANNOTATION_QUOTE_MAX_LENGTH),
  ),
  startOffset: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
const spansSchema = v.pipe(
  v.array(spanSchema),
  v.minLength(1),
  v.maxLength(READER_ANNOTATION_MAX_SPANS),
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
      v.maxLength(READER_ANNOTATION_BODY_MAX_LENGTH),
    ),
    kind: v.literal("comment"),
    spans: spansSchema,
    visibility: annotationVisibilitySchema,
  }),
]);
const guestAnnotationSchema = v.object({
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  input: inputSchema,
  requestId: uuidSchema,
  rowIds: v.pipe(
    v.array(uuidSchema),
    v.minLength(1),
    v.maxLength(READER_ANNOTATION_MAX_SPANS),
  ),
  targetId: uuidSchema,
  targetType: annotationTargetTypeSchema,
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

/** The document a guest mark sits on, in the terms the store keys it by. */
export type GuestAnnotationTarget = Pick<
  GuestAnnotation,
  "targetId" | "targetType"
>;

export const EMPTY_GUEST_ANNOTATION_STORE: GuestAnnotationStore = {
  items: [],
  version: GUEST_ANNOTATIONS_VERSION,
};

type GuestAnnotationStorage = Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
>;

const isCoherent = (store: GuestAnnotationStore): boolean =>
  store.items.every(
    (item) =>
      item.rowIds.length === item.input.spans.length &&
      item.input.spans.every((span) => span.endOffset > span.startOffset),
  );

const guestAnnotationsEntry = definePersistedState({
  key: GUEST_ANNOTATIONS_STORAGE_KEY,
  area: "session",
  version: 1,
  schema: guestAnnotationStoreSchema,
  maxBytes: 512_000,
  defaultValue: () => EMPTY_GUEST_ANNOTATION_STORE,
  scopeCheck: (value) =>
    isCoherent(value) ? keepInAnyScope(value) : { keep: false },
  restoredUi: false,
});
/** What this tab holds as a validated current payload. */
export const readGuestAnnotationStore = (
  storage: GuestAnnotationStorage,
): GuestAnnotationStore =>
  readPersistedState(guestAnnotationsEntry, {}, storage);

export const writeGuestAnnotationStore = (
  storage: GuestAnnotationStorage,
  store: GuestAnnotationStore,
) =>
  writePersistedState(guestAnnotationsEntry, {}, store, storage).mapError(
    (cause) =>
      new ClientOperationError({
        action: "store-guest-reader-annotation",
        cause,
        message: "Guest annotation storage is unavailable",
      }),
  );

export const removeGuestAnnotation = (
  storage: GuestAnnotationStorage,
  requestId: string,
) => {
  const current = readGuestAnnotationStore(storage);
  const next = {
    items: current.items.filter((item) => item.requestId !== requestId),
    version: GUEST_ANNOTATIONS_VERSION,
  } as const satisfies GuestAnnotationStore;

  const mapError = (cause: unknown) =>
    new ClientOperationError({
      action: "remove-guest-reader-annotation",
      cause,
      message: "Guest annotation storage could not be cleared",
    });
  if (next.items.length === 0) {
    return removePersistedState(guestAnnotationsEntry, {}, storage)
      .mapError(mapError)
      .map(() => next);
  }
  return writePersistedState(guestAnnotationsEntry, {}, next, storage)
    .mapError(mapError)
    .map(() => next);
};

export const createGuestAnnotation = ({
  input,
  newId,
  now,
  store,
  target,
}: {
  input: CreateAnnotationInput;
  newId: () => string;
  now: Date;
  store: GuestAnnotationStore;
  target: GuestAnnotationTarget;
}): GuestAnnotationStore => {
  if (store.items.length >= GUEST_ANNOTATIONS_MAX_ITEMS) {
    return store;
  }
  const requestId = newId();
  const item: GuestAnnotation = {
    createdAt: now.toISOString(),
    input,
    requestId,
    rowIds: input.spans.map((_, index) => (index === 0 ? requestId : newId())),
    targetId: target.targetId,
    targetType: target.targetType,
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

const isOnTarget = (
  item: GuestAnnotation,
  target: GuestAnnotationTarget,
): boolean =>
  item.targetType === target.targetType && item.targetId === target.targetId;

export const guestAnnotationsOnTarget = (
  store: GuestAnnotationStore,
  target: GuestAnnotationTarget,
): GuestAnnotation[] => store.items.filter((item) => isOnTarget(item, target));

export const guestAnnotationRows = ({
  authorName,
  store,
  target,
}: {
  authorName: string;
  store: GuestAnnotationStore;
  target: GuestAnnotationTarget;
}): ReaderAnnotation[] =>
  guestAnnotationsOnTarget(store, target).flatMap((item) => {
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
          item.input.kind === "comment" && index === 0 ? item.input.body : null,
        color: item.input.kind === "highlight" ? item.input.color : null,
        createdAt: item.createdAt,
        endOffset: span.endOffset,
        groupId,
        id: toSafeId<"legalReaderAnnotation">(rowId),
        kind: item.input.kind,
        mine: true,
        quote: span.quote,
        startOffset: span.startOffset,
        style: item.input.kind === "highlight" ? item.input.style : null,
        updatedAt: item.createdAt,
        visibility: item.input.visibility,
      };
    });
  });
