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

import { afterEach, describe, expect, test } from "bun:test";

import { openEmailCitationSource } from "@/components/chat/entity-open";
import {
  isEntityActiveInMainRoute,
  isFileActiveInMainRoute,
} from "@/components/chat/entity-route-detect";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";

afterEach(() => {
  useInspectorTabsStore.setState({
    activeId: null,
    minimized: false,
    tabs: [],
  });
});

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

describe("isFileActiveInMainRoute", () => {
  test("matches only the file field rendered in the main route", () => {
    const location = at(
      "/workspaces/ws_1/all/document",
      "?entity=ent_1&field=field_1",
    );

    expect(
      isFileActiveInMainRoute({
        entityId: "ent_1",
        fieldId: "field_1",
        location,
        workspaceId: "ws_1",
      }),
    ).toBe(true);
    expect(
      isFileActiveInMainRoute({
        entityId: "ent_1",
        fieldId: "field_2",
        location,
        workspaceId: "ws_1",
      }),
    ).toBe(false);
  });
});

test("opening an email citation switches an existing tab to preview", () => {
  const source = {
    entityId: "entity-1",
    entityName: "Message",
    fieldId: "field-email",
    fileName: "message.eml",
    mimeType: "message/rfc822",
    pdfFileId: null,
    propertyId: "property-1",
  };

  for (const facet of ["attachments", "metadata", "versions"] as const) {
    useInspectorTabsStore.setState({
      activeId: null,
      minimized: true,
      tabs: [],
    });
    useInspectorTabsStore.getState().openFile({
      id: source.fieldId,
      entityId: source.entityId,
      label: source.entityName,
      fileName: source.fileName,
      mimeType: source.mimeType,
      pdfFileId: source.pdfFileId,
      propertyId: source.propertyId,
      workspaceId: "workspace-1",
    });
    useInspectorTabsStore.getState().setFileFacet(source.fieldId, facet);
    useInspectorTabsStore.getState().setMinimized(true);

    openEmailCitationSource({ source, workspaceId: "workspace-1" });

    expect(useInspectorTabsStore.getState()).toMatchObject({
      activeId: source.fieldId,
      minimized: false,
    });
    expect(
      useInspectorTabsStore
        .getState()
        .tabs.find((tab) => tab.id === source.fieldId),
    ).toMatchObject({ facet: "preview", type: "pdf" });
  }
});
