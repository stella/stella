import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  READER_ANNOTATION_BODY_MAX_LENGTH,
  READER_ANNOTATION_COLORS,
  READER_ANNOTATION_MAX_SPANS,
  READER_ANNOTATION_QUOTE_MAX_LENGTH,
  READER_ANNOTATION_STYLES,
  READER_ANNOTATION_VISIBILITIES,
  READER_DOCUMENT_TARGET_TYPES,
} from "@stll/api-contract/legal-reader-annotations";
import { mapWithConcurrency } from "@stll/concurrency";

import type {
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from "@/components/legal-reader/annotations/annotation-types";
import type { ReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotations-query";
import {
  CLAIMED_GUEST_ANNOTATIONS_STORAGE_KEY,
  GUEST_ANNOTATIONS_STORAGE_KEY,
  LEGACY_GUEST_ANNOTATIONS_STORAGE_KEY,
} from "@/lib/account/storage-keys";
import { userStorageKey } from "@/lib/account/user-scoped-storage";
import type { StorageOwner } from "@/lib/account/user-scoped-storage";
import { ClientOperationError } from "@/lib/errors/client";
import { toSafeId } from "@/lib/safe-id";
import { readStoredJson } from "@/lib/stored-json";

/**
 * Where a tab that was reading a decision when this shipped still holds its
 * marks. Session storage, so the window is one open tab wide, but the marks
 * are the reader's own words and are not worth dropping.
 */
/**
 * v1 held decision notes under `decisionId`, before statutes could be marked.
 * v2 names the document the way the reader and the API now do.
 */
const GUEST_ANNOTATIONS_VERSION = 2;
export const GUEST_ANNOTATIONS_MAX_ITEMS = 100;

const annotationColorSchema = v.picklist(READER_ANNOTATION_COLORS);
const annotationStyleSchema = v.picklist(READER_ANNOTATION_STYLES);
const annotationVisibilitySchema = v.picklist(READER_ANNOTATION_VISIBILITIES);
const annotationTargetTypeSchema = v.picklist(READER_DOCUMENT_TARGET_TYPES);
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

/** The v1 payload, read once so a tab's existing marks survive the rename. */
const legacyGuestAnnotationStoreSchema = v.object({
  items: v.pipe(
    v.array(
      v.object({
        createdAt: v.pipe(v.string(), v.isoTimestamp()),
        decisionId: uuidSchema,
        input: inputSchema,
        requestId: uuidSchema,
        rowIds: v.pipe(
          v.array(uuidSchema),
          v.minLength(1),
          v.maxLength(READER_ANNOTATION_MAX_SPANS),
        ),
      }),
    ),
    v.maxLength(GUEST_ANNOTATIONS_MAX_ITEMS),
  ),
  version: v.literal(1),
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

export type GuestAnnotationStorage = Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
>;

const isCoherent = (store: GuestAnnotationStore): boolean =>
  store.items.every(
    (item) =>
      item.rowIds.length === item.input.spans.length &&
      item.input.spans.every((span) => span.endOffset > span.startOffset),
  );

/**
 * What this tab holds, as the current payload. A payload from before statutes
 * could be marked is read as decision notes rather than discarded: the marks
 * are the reader's own words and nothing about them changed.
 */
export const readGuestAnnotationStore = (
  storage: GuestAnnotationStorage,
): GuestAnnotationStore => {
  const raw = Result.try(() => storage.getItem(GUEST_ANNOTATIONS_STORAGE_KEY));
  if (Result.isError(raw)) {
    return EMPTY_GUEST_ANNOTATION_STORE;
  }
  const parsed = readStoredJson(raw.value, guestAnnotationStoreSchema);
  if (parsed !== null) {
    return isCoherent(parsed) ? parsed : EMPTY_GUEST_ANNOTATION_STORE;
  }
  if (raw.value !== null) {
    return EMPTY_GUEST_ANNOTATION_STORE;
  }

  const legacyRaw = Result.try(() =>
    storage.getItem(LEGACY_GUEST_ANNOTATIONS_STORAGE_KEY),
  );
  if (Result.isError(legacyRaw)) {
    return EMPTY_GUEST_ANNOTATION_STORE;
  }
  const legacy = readStoredJson(
    legacyRaw.value,
    legacyGuestAnnotationStoreSchema,
  );
  if (legacy === null) {
    return EMPTY_GUEST_ANNOTATION_STORE;
  }
  const migrated: GuestAnnotationStore = {
    items: legacy.items.map((item) => ({
      createdAt: item.createdAt,
      input: item.input,
      requestId: item.requestId,
      rowIds: item.rowIds,
      targetId: item.decisionId,
      targetType: "decision",
    })),
    version: GUEST_ANNOTATIONS_VERSION,
  };
  return isCoherent(migrated) ? migrated : EMPTY_GUEST_ANNOTATION_STORE;
};

export const writeGuestAnnotationStore = (
  storage: GuestAnnotationStorage,
  store: GuestAnnotationStore,
) =>
  Result.try({
    try: () => {
      storage.setItem(GUEST_ANNOTATIONS_STORAGE_KEY, JSON.stringify(store));
      // The migrated payload is now the only copy; leaving the old key would
      // let it come back the next time this one is cleared.
      storage.removeItem(LEGACY_GUEST_ANNOTATIONS_STORAGE_KEY);
    },
    catch: (cause) =>
      new ClientOperationError({
        action: "store-guest-reader-annotation",
        cause,
        message: "Guest annotation storage is unavailable",
      }),
  });

/** An account that takes over the tab's guest marks. */
export type GuestAnnotationClaimant = Extract<StorageOwner, { kind: "user" }>;

/**
 * Marks an account has claimed but not uploaded yet. Not capped like the
 * tab's own store: a sign-out mid-upload leaves some here, and the next
 * visitor in the tab may leave a full store on top for this account.
 */
const claimedGuestAnnotationStoreSchema = v.object({
  items: v.array(guestAnnotationSchema),
  version: v.literal(GUEST_ANNOTATIONS_VERSION),
});

const claimedKey = (owner: GuestAnnotationClaimant) =>
  userStorageKey(CLAIMED_GUEST_ANNOTATIONS_STORAGE_KEY, owner);

const readClaimedGuestAnnotations = (
  storage: GuestAnnotationStorage,
  owner: GuestAnnotationClaimant,
): GuestAnnotationStore => {
  const raw = Result.try(() => storage.getItem(claimedKey(owner)));
  if (Result.isError(raw)) {
    return EMPTY_GUEST_ANNOTATION_STORE;
  }
  const parsed = readStoredJson(raw.value, claimedGuestAnnotationStoreSchema);
  return parsed !== null && isCoherent(parsed)
    ? parsed
    : EMPTY_GUEST_ANNOTATION_STORE;
};

const claimFailed = (cause: unknown) =>
  new ClientOperationError({
    action: "claim-guest-reader-annotations",
    cause,
    message: "Guest annotation storage is unavailable",
  });

/**
 * Moves the tab's guest marks under `owner`'s own key and returns every mark
 * that account still has to upload. Keyed by the account, they outlast its
 * sign-out for its next sign-in in this tab, and no other account reads them.
 */
export const claimGuestAnnotations = (
  storage: GuestAnnotationStorage,
  owner: GuestAnnotationClaimant,
): Result<GuestAnnotationStore, ClientOperationError> => {
  const claimed = readClaimedGuestAnnotations(storage, owner);
  const guest = readGuestAnnotationStore(storage);
  if (guest.items.length === 0) {
    return Result.ok(claimed);
  }
  const held = new Set(claimed.items.map((item) => item.requestId));
  const next: GuestAnnotationStore = {
    items: [
      ...claimed.items,
      ...guest.items.filter((item) => !held.has(item.requestId)),
    ],
    version: GUEST_ANNOTATIONS_VERSION,
  };
  return Result.try({
    try: () => {
      // The account's copy is written before the tab's goes, so the marks
      // always have one home.
      storage.setItem(claimedKey(owner), JSON.stringify(next));
      storage.removeItem(GUEST_ANNOTATIONS_STORAGE_KEY);
      storage.removeItem(LEGACY_GUEST_ANNOTATIONS_STORAGE_KEY);
    },
    catch: claimFailed,
  }).map(() => next);
};

const removeClaimedGuestAnnotation = (
  storage: GuestAnnotationStorage,
  owner: GuestAnnotationClaimant,
  requestId: string,
) => {
  const items = readClaimedGuestAnnotations(storage, owner).items.filter(
    (item) => item.requestId !== requestId,
  );
  return Result.try({
    try: () => {
      if (items.length === 0) {
        storage.removeItem(claimedKey(owner));
        return;
      }
      storage.setItem(
        claimedKey(owner),
        JSON.stringify({ items, version: GUEST_ANNOTATIONS_VERSION }),
      );
    },
    catch: claimFailed,
  });
};

/**
 * Uploads the marks `owner` claimed, at most `limit` at a time, removing each
 * only once its upload succeeded. Nothing is posted once `owner` is no longer
 * signed in; what is left waits under their key for their next sign-in, and
 * each mark's request id keeps a repeated upload from creating it twice.
 */
export const uploadClaimedGuestAnnotations = async ({
  isCurrentOwner,
  items,
  limit,
  owner,
  storage,
  upload,
}: {
  isCurrentOwner: () => boolean;
  items: readonly GuestAnnotation[];
  limit: number;
  owner: GuestAnnotationClaimant;
  storage: GuestAnnotationStorage;
  upload: (item: GuestAnnotation) => Promise<Result<void, Error>>;
}): Promise<Result<void, Error>[]> =>
  await mapWithConcurrency({
    items,
    limit,
    operation: async (item): Promise<Result<void, Error>> => {
      if (!isCurrentOwner()) {
        return Result.ok(undefined);
      }
      const uploaded = await upload(item);
      if (Result.isError(uploaded)) {
        return uploaded;
      }
      return removeClaimedGuestAnnotation(storage, owner, item.requestId);
    },
  });

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
