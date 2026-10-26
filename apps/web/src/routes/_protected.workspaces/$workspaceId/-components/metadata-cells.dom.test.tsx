import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type { WorkspaceEntity } from "@/lib/types";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");
const { toSafeId } = await import("@/lib/safe-id");
const { VersionHistoryCell } = await import("./metadata-cells");

const WORKSPACE_ID = "workspace-1";
const PROPERTY_ID = toSafeId<"property">("property-documents");
const FIELD_ID = toSafeId<"field">("field-contract");
const SHOW_VERSION_HISTORY = messages.fileDetail.showVersionList;

type FileFixture = { fileName: string; mimeType: string };

const entity = ({
  kind,
  file,
}: {
  kind: WorkspaceEntity["kind"];
  file: FileFixture | null;
}) =>
  ({
    entityId: toSafeId<"entity">("entity-contract"),
    kind,
    name: "Supply agreement",
    parentId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: null,
    createdByUserId: null,
    createdByImage: null,
    createdByDeletedAt: null,
    updatedAt: null,
    version: 3,
    currentVersionReference: null,
    status: null,
    priority: null,
    listItemType: null,
    dueDate: null,
    agendaKind: null,
    startAt: null,
    endAt: null,
    occurredAt: null,
    remindAt: null,
    allDay: false,
    timeZone: null,
    location: null,
    onlineMeetingUrl: null,
    availability: null,
    sensitivity: null,
    organizer: null,
    attendees: null,
    recurrence: null,
    agendaSource: "manual",
    externalSource: null,
    externalId: null,
    externalChangeKey: null,
    externalICalUid: null,
    readOnly: false,
    sortOrder: null,
    activeEditBy: null,
    fields:
      file === null
        ? {}
        : {
            [PROPERTY_ID]: {
              id: FIELD_ID,
              propertyId: PROPERTY_ID,
              entityId: toSafeId<"entity">("entity-contract"),
              content: {
                type: "file" as const,
                version: 1 as const,
                id: "file-contract",
                fileName: file.fileName,
                mimeType: file.mimeType,
                sizeBytes: 1,
                encrypted: false,
                sha256Hex: "a".repeat(64),
                pdfFileId: null,
              },
            },
          },
    cellMetadata: {},
    assignees: [],
  }) satisfies WorkspaceEntity;

const PDF = { fileName: "supply-agreement.pdf", mimeType: "application/pdf" };

const renderCell = (row: WorkspaceEntity) =>
  render(
    <IntlProvider locale="en" messages={messages}>
      <div className="relative">
        <VersionHistoryCell entity={row} workspaceId={WORKSPACE_ID} />
      </div>
    </IntlProvider>,
  );

const fileTab = () =>
  useInspectorTabsStore.getState().tabs.find((tab) => tab.id === FIELD_ID);

afterEach(() => {
  cleanup();
  useInspectorTabsStore.getState().closeAll();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

describe("table version cell", () => {
  test("opens the row's file on the version history facet", () => {
    renderCell(entity({ kind: "document", file: PDF }));

    const button = screen.getByRole("button", { name: SHOW_VERSION_HISTORY });
    expect(button.textContent).toBe("3");
    fireEvent.click(button);

    expect(useInspectorTabsStore.getState().activeId).toBe(FIELD_ID);
    expect(fileTab()).toMatchObject({
      type: "pdf",
      entityId: "entity-contract",
      facet: "versions",
      workspaceId: WORKSPACE_ID,
    });
  });

  test("switches a file already open on another facet to version history", () => {
    renderCell(entity({ kind: "document", file: PDF }));
    useInspectorTabsStore.getState().openFile({
      id: FIELD_ID,
      entityId: "entity-contract",
      label: "Supply agreement",
      fileName: PDF.fileName,
      mimeType: PDF.mimeType,
      pdfFileId: null,
      workspaceId: WORKSPACE_ID,
    });
    useInspectorTabsStore.getState().setFileFacet(FIELD_ID, "metadata");

    fireEvent.click(screen.getByRole("button", { name: SHOW_VERSION_HISTORY }));

    expect(fileTab()?.facet).toBe("versions");
  });

  test.each([
    ["a task", entity({ kind: "task", file: null })],
    ["a document without a file", entity({ kind: "document", file: null })],
    [
      "a file the inspector cannot display",
      entity({
        kind: "document",
        file: { fileName: "bundle.zip", mimeType: "application/zip" },
      }),
    ],
  ])("stays inert for %s", (_label, row) => {
    renderCell(row);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("3")).toBeDefined();
  });
});
