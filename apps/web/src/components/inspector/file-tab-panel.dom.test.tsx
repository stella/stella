import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { DocxBrowserEditorActions } from "@/components/docx/use-docx-browser-editor-actions";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({
  url: "http://localhost:3000/workspaces/workspace-1",
});

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/chat/")) {
      return Response.json({ messages: [] });
    }
    return Response.json({ olderCursor: null, versions: [] });
  },
  { preconnect: originalFetch.preconnect },
);

let docxEngineRenderCount = 0;
let pdfEngineRenderCount = 0;

Object.assign(globalThis, {
  recordDocxEngineRender: () => {
    docxEngineRenderCount += 1;
  },
  recordPdfEngineRender: () => {
    pdfEngineRenderCount += 1;
  },
});

Bun.plugin({
  name: "file-tab-rendering-engine-test-loader",
  setup(build) {
    build.onLoad({ filter: /docx-browser-editor\.tsx$/u }, () => ({
      contents: `
        import React from "react";
        export const DocxBrowserEditor = ({ onScrollTopChange }) => {
          globalThis.recordDocxEngineRender();
          return React.createElement("button", {
            "aria-label": "DOCX engine",
            "data-testid": "docx-engine",
            onClick: () => onScrollTopChange?.(120),
            type: "button",
          });
        };
      `,
      loader: "js",
    }));
    build.onLoad({ filter: /pdf-viewport\.tsx$/u }, () => ({
      contents: `
        import React from "react";
        export const PDFViewport = () => {
          globalThis.recordPdfEngineRender();
          return React.createElement("div", { "data-testid": "pdf-engine" });
        };
      `,
      loader: "js",
    }));
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "worker.js";',
      loader: "js",
    }));
  },
});

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { DocxEditorHost } = await import("@/components/docx/docx-editor-host");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { useDocxEditorHostStore } =
  await import("@/components/docx/docx-editor-host-store");
const { FileTabPanel } = await import("./file-tab-panel");
const { fileOptions } = await import("@/lib/files/queries");
const { fileChatThreadOptions } = await import("@/features/chat/queries");
const { mcpConnectorsOptions } = await import("@/lib/knowledge/queries");
const { entityOptions } = await import("@/lib/workspaces/queries/entities");
const { bundledEnglishMessages } = await import("@/i18n/i18n-store");

class ResizeObserverStub implements ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: ResizeObserverStub,
});
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get: () => 800,
});

const WORKSPACE_ID = "workspace-1";
const ENTITY_ID = toSafeId<"entity">("entity-1");
const ENTITY_VERSION_ID = toSafeId<"entityVersion">("entity-version-1");
const DOCX_FIELD_ID = toSafeId<"field">("docx-field-1");
const PDF_FIELD_ID = toSafeId<"field">("pdf-field-1");
const PROPERTY_ID = toSafeId<"property">("property-1");

const baseTab = {
  type: "pdf" as const,
  entityId: ENTITY_ID,
  facet: "preview" as const,
  metadataLane: "closed" as const,
  pdfFileId: null,
  workspaceId: WORKSPACE_ID,
};

const docxTab = {
  ...baseTab,
  fileName: "submission.docx",
  id: DOCX_FIELD_ID,
  label: "Submission",
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  propertyId: PROPERTY_ID,
};

const pdfTab = {
  ...baseTab,
  fileName: "exhibit.pdf",
  id: PDF_FIELD_ID,
  label: "Exhibit",
  mimeType: "application/pdf",
  propertyId: PROPERTY_ID,
};

const noop = () => undefined;
const openFullView = async () => undefined;

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
  useDocxEditorHostStore.setState({
    attachedSlots: {},
    registry: {},
    slotElements: {},
  });
  docxEngineRenderCount = 0;
  pdfEngineRenderCount = 0;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

test("native DOCX keeps the host registry and editor inside the render budget", async () => {
  const mounted = renderFileTab(docxTab);
  const engine = await waitFor(() => mounted.getByTestId("docx-engine"));
  expect(engine.isConnected).toBeTrue();
  expect(docxEngineRenderCount).toBe(1);

  const registryAfterMount = useDocxEditorHostStore.getState().registry;
  const claim = Object.values(registryAfterMount).at(0)?.lastClaim;
  if (!claim) {
    throw new Error(
      `The mounted DOCX slot did not publish its host claim: ${JSON.stringify(registryAfterMount)}`,
    );
  }
  expect(claim.bindings.onScrollTopChange).toBeFunction();
  const rendersAfterMount = docxEngineRenderCount;

  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      fireEvent.click(mounted.getByTestId("parent-rerender"));
    });
  }
  for (let index = 0; index < 50; index += 1) {
    await act(async () => {
      claim.bindings.onScrollTopChange?.(120);
    });
  }

  expect(useDocxEditorHostStore.getState().registry).toBe(registryAfterMount);
  expect(docxEngineRenderCount - rendersAfterMount).toBeLessThanOrEqual(1);
});

test("PDF keeps the host registry and PDF engine inside the render budget", async () => {
  const mounted = renderFileTab(pdfTab);
  const engine = await waitFor(() => mounted.getByTestId("pdf-engine"));
  expect(engine.isConnected).toBeTrue();
  expect(pdfEngineRenderCount).toBe(1);

  const registryAfterMount = useDocxEditorHostStore.getState().registry;
  const rendersAfterMount = pdfEngineRenderCount;

  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      fireEvent.click(mounted.getByTestId("parent-rerender"));
    });
  }
  for (let index = 0; index < 50; index += 1) {
    await act(async () => {
      fireEvent.click(mounted.getByTestId("report-scroll-top"));
    });
  }

  expect(useDocxEditorHostStore.getState().registry).toBe(registryAfterMount);
  expect(pdfEngineRenderCount - rendersAfterMount).toBeLessThanOrEqual(1);
});

function renderFileTab(tab: typeof docxTab | typeof pdfTab) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(
    fileOptions({ fieldId: tab.id, workspaceId: tab.workspaceId }).queryKey,
    {
      buffer: new ArrayBuffer(0),
      fileId: tab.id,
      fileName: tab.fileName,
      mimeType: tab.mimeType,
      originalMimeType: tab.mimeType,
    },
  );
  queryClient.setQueryData(
    fileOptions({
      fieldId: tab.id,
      purpose: "native-display",
      workspaceId: tab.workspaceId,
    }).queryKey,
    {
      buffer: new ArrayBuffer(0),
      fileId: tab.id,
      fileName: tab.fileName,
      mimeType: tab.mimeType,
      originalMimeType: tab.mimeType,
    },
  );
  queryClient.setQueryData(
    entityOptions(tab.workspaceId, tab.entityId).queryKey,
    {
      entityId: tab.entityId,
      kind: "document",
      name: tab.label,
      currentVersionId: ENTITY_VERSION_ID,
      currentVersionCreatedAt: "2026-10-17T00:00:00.000Z",
      extractionFileFieldId: null,
      currentVersionReference: null,
      fields: [
        {
          content: {
            type: "file",
            version: 1,
            id: `file-${tab.id}`,
            fileName: tab.fileName,
            mimeType: tab.mimeType,
            sizeBytes: 0,
            encrypted: false,
            sha256Hex: "sha256-file-tab-panel",
            pdfFileId: null,
            thumbnailFileId: null,
          },
          id: tab.id,
          propertyId: tab.propertyId,
        },
      ],
    },
    { updatedAt: Date.now() + 60_000 },
  );
  queryClient.setQueryData(
    fileChatThreadOptions({
      activeOrganizationId: "organization-1",
      hasDocxEditSurface: true,
      key: {
        entityId: tab.entityId,
        fieldId: tab.id,
        userId: "user-1",
        workspaceId: tab.workspaceId,
      },
    }).queryKey,
    {
      threadExists: false,
      threadId: toChatThreadId("draft-file-thread"),
    },
  );
  queryClient.setQueryData(mcpConnectorsOptions("organization-1").queryKey, {
    canManageCustomConnectors: false,
    connectors: [],
    nativeTools: [],
  });

  const docxActionsRef = {
    current: new Map<string, DocxBrowserEditorActions>(),
  };

  const Harness = () => {
    const [, setParentRender] = React.useState(0);
    const [, setDocxCompatibilityByTab] = React.useState(new Map());
    const [docxScrollTopByTab, setDocxScrollTopByTab] = React.useState(
      new Map<string, number>([[tab.id, 120]]),
    );
    const [editingDocxTabId, setEditingDocxTabId] = React.useState<
      string | null
    >(null);
    const [editingTabId, setEditingTabId] = React.useState<string | null>(null);
    const [editValue, setEditValue] = React.useState("");
    const [scaleOffsets, setScaleOffsets] = React.useState(new Map());

    return (
      <QueryClientProvider client={queryClient}>
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: "organization-1",
            email: "reader@example.test",
            id: "user-1",
            image: null,
            name: "Reader",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <IntlProvider
            locale="en"
            messages={bundledEnglishMessages}
            timeZone="UTC"
          >
            <FormattingProvider locale="en" timeZone="UTC">
              <button
                data-testid="parent-rerender"
                onClick={() => setParentRender((value) => value + 1)}
                type="button"
              >
                {bundledEnglishMessages.common.retry}
              </button>
              <button
                data-testid="report-scroll-top"
                onClick={() => setDocxScrollTopByTab((current) => current)}
                type="button"
              >
                {bundledEnglishMessages.common.retry}
              </button>
              <FileTabPanel
                activeId={tab.id}
                canUpdateEntity={false}
                closeAll={noop}
                commitRename={noop}
                docxActionsRef={docxActionsRef}
                docxScrollTopByTab={docxScrollTopByTab}
                editingDocxTabId={editingDocxTabId}
                editingTabId={editingTabId}
                editValue={editValue}
                handleCloseTab={noop}
                handleMinimizeFromFullView={noop}
                handleOpenFullView={openFullView}
                handleResetZoom={noop}
                handleWheelZoom={noop}
                handleZoom={noop}
                matterOrigin={null}
                minimized={false}
                mountedPdfIds={new Set([tab.id])}
                documentReviewPaneFieldId={null}
                pdfRouteJustification={null}
                peekPdfViewId="peek-view"
                ribbonLabelContextMenuOpenAt={noop}
                scaleOffsets={scaleOffsets}
                setDocxCompatibilityByTab={setDocxCompatibilityByTab}
                setDocxScrollTopByTab={setDocxScrollTopByTab}
                setEditingTabId={setEditingTabId}
                setEditingDocxTabId={setEditingDocxTabId}
                setEditValue={setEditValue}
                setScaleOffsets={setScaleOffsets}
                startRename={noop}
                tab={tab}
              />
            </FormattingProvider>
          </IntlProvider>
        </AuthenticatedUserProvider>
      </QueryClientProvider>
    );
  };

  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider
        locale="en"
        messages={bundledEnglishMessages}
        timeZone="UTC"
      >
        <DocxEditorHost />
      </IntlProvider>
    </QueryClientProvider>,
  );
  return render(<Harness />);
}
