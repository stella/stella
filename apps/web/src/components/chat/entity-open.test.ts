/**
 * Tests for `isEntityActiveInMainRoute` — the route-detection
 * guard that decides whether a chat-mention click should open a
 * duplicate file lane or surface metadata in the inspector.
 *
 * The previous implementation matched `${entityId}` as a path
 * segment but the actual route uses `viewId` (typically "all")
 * with the entity in the search param, so the guard was dead in
 * practice.
 */

import { describe, expect, test } from "bun:test";

import { isEntityActiveInMainRoute } from "@/components/chat/entity-route-detect";

const at = (pathname: string, search = "") => ({ pathname, search });

describe("isEntityActiveInMainRoute", () => {
  test("matches the document route under any viewId when search.entity is set", () => {
    expect(
      isEntityActiveInMainRoute(
        "ent_1",
        "ws_1",
        at("/workspaces/ws_1/all/document", "?entity=ent_1&field=f_2"),
      ),
    ).toBe(true);
  });

  test("matches when viewId is a custom view, not just 'all'", () => {
    expect(
      isEntityActiveInMainRoute(
        "ent_1",
        "ws_1",
        at("/workspaces/ws_1/contracts/document", "?entity=ent_1"),
      ),
    ).toBe(true);
  });

  test("does not match when the entity search param targets a different entity", () => {
    expect(
      isEntityActiveInMainRoute(
        "ent_1",
        "ws_1",
        at("/workspaces/ws_1/all/document", "?entity=ent_2"),
      ),
    ).toBe(false);
  });

  test("does not match a non-document route", () => {
    expect(
      isEntityActiveInMainRoute(
        "ent_1",
        "ws_1",
        at("/workspaces/ws_1/all", "?entity=ent_1"),
      ),
    ).toBe(false);
  });

  test("does not match a different workspace", () => {
    expect(
      isEntityActiveInMainRoute(
        "ent_1",
        "ws_1",
        at("/workspaces/ws_2/all/document", "?entity=ent_1"),
      ),
    ).toBe(false);
  });

  test("does not match when the entity search param is missing", () => {
    expect(
      isEntityActiveInMainRoute(
        "ent_1",
        "ws_1",
        at("/workspaces/ws_1/all/document", ""),
      ),
    ).toBe(false);
  });

  test("matches with extra path segments after /document", () => {
    expect(
      isEntityActiveInMainRoute(
        "ent_1",
        "ws_1",
        at("/workspaces/ws_1/all/document/edit", "?entity=ent_1"),
      ),
    ).toBe(true);
  });

  test("returns false when no location is available (server-side render)", () => {
    expect(isEntityActiveInMainRoute("ent_1", "ws_1", null)).toBe(false);
  });
});
