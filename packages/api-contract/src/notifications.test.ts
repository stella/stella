import { describe, expect, test } from "bun:test";

import {
  NOTIFICATION_ENTITY_TYPE,
  NOTIFICATION_ENTITY_TYPES,
  NOTIFICATION_KIND,
  NOTIFICATION_KINDS,
} from "./notifications";
import type {
  NotificationContent,
  NotificationEntityType,
  NotificationKind,
  NotificationMetadataByKind,
} from "./notifications";

/**
 * Compile-time coherence: `NotificationContent` must offer exactly one branch
 * per kind, carrying exactly that kind's metadata. A kind added to
 * `NOTIFICATION_KIND` without a metadata shape already fails the constraint
 * inside `notifications.ts`; these aliases additionally pin that the union the
 * producers accept is derived from that map rather than restated beside it.
 */
type BranchFor<K extends NotificationKind> = Extract<
  NotificationContent,
  { kind: K }
>;
type AssertEqual<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

const metadataMatchesKind: AssertEqual<
  BranchFor<"mention">["metadata"],
  NotificationMetadataByKind["mention"]
> = true;
const announcementMetadataMatchesKind: AssertEqual<
  BranchFor<"announcement">["metadata"],
  NotificationMetadataByKind["announcement"]
> = true;
const unionCoversEveryKind: AssertEqual<
  NotificationContent["kind"],
  NotificationKind
> = true;

describe("notification kinds", () => {
  test("the kind list and the kind map name the same values", () => {
    expect([...NOTIFICATION_KINDS].sort()).toEqual(
      Object.values(NOTIFICATION_KIND).sort(),
    );
    expect(new Set(NOTIFICATION_KINDS).size).toBe(NOTIFICATION_KINDS.length);
  });

  test("the entity-type list and map name the same values", () => {
    expect([...NOTIFICATION_ENTITY_TYPES].sort()).toEqual(
      Object.values(NOTIFICATION_ENTITY_TYPE).sort(),
    );
  });

  test("kinds are stored values, never i18n keys", () => {
    // A kind reaches the database verbatim, so it must stay a stable
    // snake_case token. A dotted value would mean somebody stored a message
    // key, which is the drift this contract exists to prevent.
    for (const kind of NOTIFICATION_KINDS) {
      expect(kind).toMatch(/^[a-z][a-z_]*$/u);
    }
  });

  test("every entity type is a stable token too", () => {
    for (const entityType of NOTIFICATION_ENTITY_TYPES) {
      expect(entityType).toMatch(/^[a-z][a-z_]*$/u);
      // Keeps the array's element type honest against the union.
      const typed: NotificationEntityType = entityType;
      expect(typed).toBe(entityType);
    }
  });

  test("the compile-time coherence assertions hold", () => {
    expect(metadataMatchesKind).toBe(true);
    expect(announcementMetadataMatchesKind).toBe(true);
    expect(unionCoversEveryKind).toBe(true);
  });
});
