/**
 * Tests for `isEntityActiveInMainRoute` — the guard that decides whether a
 * chat-mention click should open a duplicate file lane or surface metadata
 * in the inspector.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  openEmailCitationSource,
  openEntityFileFieldInInspector,
} from "@/components/chat/entity-open";
import {
  isEntityActiveInMainRoute,
  isFileActiveInMainRoute,
} from "@/components/chat/entity-route-detect";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { toSafeId } from "@/lib/safe-id";
import type { CurrentWorkspaceDocument } from "@/lib/workspaces/use-workspace-view-params";

afterEach(() => {
  useInspectorTabsStore.setState({
    activeId: null,
    minimized: false,
    tabs: [],
  });
});

// The document page on screen, as `getCurrentWorkspaceDocument` reads it from
// the route matches.
const shown = {
  workspaceId: "ws_1",
  entityId: "ent_1",
  fieldId: "field_1",
} satisfies CurrentWorkspaceDocument;
const entity = { entityId: "ent_1", workspaceId: "ws_1" };

describe("isEntityActiveInMainRoute", () => {
  test("matches the entity the document page shows in its matter", () => {
    expect(isEntityActiveInMainRoute(entity, shown)).toBe(true);
  });

  test("does not match another entity, another matter, or no document page", () => {
    expect(
      [
        { ...shown, entityId: "ent_2" },
        { ...shown, workspaceId: "ws_2" },
        { ...shown, entityId: undefined },
        undefined,
      ].map((document) => isEntityActiveInMainRoute(entity, document)),
    ).toEqual([false, false, false, false]);
  });
});

describe("isFileActiveInMainRoute", () => {
  test("matches only the file field rendered in the main route", () => {
    expect(
      ["field_1", "field_2"].map((fieldId) =>
        isFileActiveInMainRoute({ ...entity, fieldId }, shown),
      ),
    ).toEqual([true, false]);
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

    openEmailCitationSource({
      documentOnScreen: undefined,
      source,
      workspaceId: "workspace-1",
    });

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

test("an email citation the document page already shows opens on its metadata", () => {
  const source = {
    entityId: "entity-1",
    entityName: "Message",
    fieldId: "field-email",
    fileName: "message.eml",
    mimeType: "message/rfc822",
    pdfFileId: null,
    propertyId: "property-1",
  };
  const lanes = [source.fieldId, "field-other"].map((fieldId) => {
    useInspectorTabsStore.setState({
      activeId: null,
      minimized: true,
      tabs: [],
    });
    openEmailCitationSource({
      documentOnScreen: {
        workspaceId: "workspace-1",
        entityId: source.entityId,
        fieldId,
      },
      source,
      workspaceId: "workspace-1",
    });
    return useInspectorTabsStore
      .getState()
      .tabs.find((tab) => tab.id === source.fieldId);
  });

  expect(lanes.at(0)).toMatchObject({ metadataLane: "expanded" });
  expect(lanes.at(1)).not.toMatchObject({ metadataLane: "expanded" });
});

test("a source-bound citation opens its exact field, not the first file", () => {
  const firstFieldId = toSafeId<"field">("field-first");
  const citedFieldId = toSafeId<"field">("field-cited");
  const fileContent = (id: string, fileName: string) => ({
    version: 1 as const,
    type: "file" as const,
    id,
    fileName,
    mimeType: "application/pdf",
    sizeBytes: 128,
    encrypted: false,
    sha256Hex: "a".repeat(64),
    pdfFileId: null,
  });
  const fields = [
    {
      id: firstFieldId,
      propertyId: toSafeId<"property">("property-first"),
      content: fileContent("file-first", "first.pdf"),
    },
    {
      id: citedFieldId,
      propertyId: toSafeId<"property">("property-cited"),
      content: fileContent("file-cited", "cited.pdf"),
    },
  ];

  expect(
    openEntityFileFieldInInspector({
      entityId: "entity-1",
      fieldId: citedFieldId,
      fields,
      label: "Loan agreement",
      workspaceId: "workspace-1",
    }),
  ).toBe(true);

  const state = useInspectorTabsStore.getState();
  expect(state.activeId).toBe(citedFieldId);
  expect(state.tabs).toHaveLength(1);
  expect(state.tabs.at(0)).toMatchObject({
    type: "pdf",
    id: citedFieldId,
    fileName: "cited.pdf",
    facet: "preview",
  });
});
