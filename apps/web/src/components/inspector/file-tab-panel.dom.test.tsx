import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  InferDataFromTag,
  QueryClient as QueryClientInstance,
} from "@tanstack/react-query";
import { afterAll, afterEach, expect, test } from "bun:test";

import { DATA_BOX_DOCUMENT_KINDS } from "@stll/api-contract/data-box";
import type { DataBoxEnvelope } from "@stll/api-contract/data-box";
import type { EInvoicePreview } from "@stll/api-contract/e-invoice";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { reactCompilerBunPlugin } from "@stll/scripts/src/react-compiler-bun-plugin";

import type { DocxBrowserEditorActions } from "@/components/docx/use-docx-browser-editor-actions";
import arabicMessages from "@/i18n/langs/ar.json";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

GlobalRegistrator.register({
  url: "http://localhost:3000/workspaces/workspace-1",
});

const originalFetch = globalThis.fetch;
/** Parts asked for through the file's part link, as `field/part`. */
const partLinkRequests: string[] = [];
/** What a part's grant answers with; any other part is a one-line PDF. */
const PART_BYTES: Readonly<Record<string, string>> = {
  "field-asic/member:2": "# První strana\nDruhý řádek",
};
/** Parts whose display the server could not convert to a PDF. */
const PARTS_NOT_CONVERTED: ReadonlySet<string> = new Set([
  "field-asic-converted/member:1",
]);
const PART_LINK = /\/files\/[^/]+\/url\/([^/?]+)\?(.*)$/u;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    const partLink = PART_LINK.exec(url);
    const part = new URLSearchParams(partLink?.[2] ?? "").get("part");
    if (partLink !== null && part !== null) {
      const key = `${partLink[1] ?? ""}/${part}`;
      partLinkRequests.push(key);
      return Response.json({
        kind: "part",
        fileName: "part",
        mimeType: "application/octet-stream",
        originalMimeType: "application/octet-stream",
        presignedUrl: `http://localhost:3001/v1/files/content/grant?part=${encodeURIComponent(key)}`,
        stampable: false,
      });
    }
    if (url.includes("/files/content/grant?part=")) {
      const key = new URL(url).searchParams.get("part") ?? "";
      if (PARTS_NOT_CONVERTED.has(key)) {
        return Response.json(
          { message: "The file could not be converted for preview" },
          { status: 422 },
        );
      }
      return new Response(PART_BYTES[key] ?? "%PDF-1.7");
    }
    if (url.includes("/e-invoice/field-e-invoice-single")) {
      return Response.json(singleInvoicePreview);
    }
    if (url.includes("/e-invoice/field-e-invoice-batch")) {
      return Response.json(invoiceBatchPreview);
    }
    if (url.includes("/structured-document/field-structured")) {
      return Response.json({ text: "İlk sayfa\n法院文件", truncated: true });
    }
    if (
      url.includes("/structured-document/field-preview-unavailable") ||
      url.includes("/e-invoice/field-e-invoice-refused") ||
      url.includes("/asic/field-asic-unsupported") ||
      url.includes("/signed-dossier/field-dossier-unsupported") ||
      url.includes("/cades/field-cades-unsupported")
    ) {
      return Response.json(
        { message: "Preview unavailable", code: "preview_unavailable" },
        { status: 422 },
      );
    }
    if (url.includes("/chat/threads/") && url.includes("/messages")) {
      return Response.json({ message: "Thread not found" }, { status: 404 });
    }
    if (url.includes("/chat/")) {
      return Response.json({ messages: [] });
    }
    return Response.json({ olderCursor: null, versions: [] });
  },
  { preconnect: originalFetch.preconnect },
);

const emptyParty = {
  name: null,
  identifiers: [],
  address: [],
} satisfies EInvoicePreview["invoices"][number]["seller"];

const sampleInvoice = {
  documentType: "invoice",
  typeCode: "1",
  number: "INV-TEST-0001",
  issueDate: "2026-01-15",
  taxPointDate: "2026-01-14",
  dueDate: "2026-01-29",
  currency: "CZK",
  seller: {
    name: "Sample Supplier Test",
    identifiers: [
      { kind: "vat", scheme: null, value: "XX0000000001" },
      { kind: "registration", scheme: "0088", value: "TEST-REG-0001" },
    ],
    address: ["1 Sample Street", "00000 Sample City", "XX"],
  },
  buyer: {
    name: "Sample Customer Test",
    identifiers: [{ kind: "vat", scheme: null, value: "XX0000000002" }],
    address: [],
  },
  lines: [
    {
      id: "1",
      description: "Sample consulting hours",
      quantity: "10.000",
      unitCode: "HUR",
      unitPrice: "100.00",
      priceBasis: { quantity: "1", unitCode: "HUR" },
      vatRate: "21",
      vatCategory: "S",
      netAmount: "1000.00",
    },
  ],
  lineCount: 3,
  vatBreakdown: [
    {
      rate: "21",
      category: "S",
      taxableAmount: "1000.00",
      taxAmount: "210.00",
      exemptionReason: null,
    },
  ],
  totals: {
    netAmount: "1000.00",
    taxAmount: "210.00",
    grossAmount: "1210.00",
    prepaidAmount: null,
    payableAmount: "1210.00",
  },
  payments: [
    {
      meansCode: "42",
      dueDate: null,
      amount: null,
      iban: "XX00TEST0000000000000001",
      bic: null,
      accountNumber: null,
      bankCode: null,
      reference: "TEST-REF-0001",
    },
  ],
  notes: ["Sample note"],
} satisfies EInvoicePreview["invoices"][number];

const singleInvoicePreview = {
  syntax: "isdoc",
  version: "6.0.2",
  invoices: [sampleInvoice],
  attachments: [
    {
      part: "attachment:0",
      fileName: "vykaz-prace-rijen-2026.pdf",
      description: "Výkaz práce za říjen 2026",
      mediaType: "application/pdf",
      sizeBytes: 2048,
    },
  ],
} satisfies EInvoicePreview;

const invoiceBatchPreview = {
  syntax: "fatturaPA",
  version: "FPR12",
  invoices: [
    sampleInvoice,
    {
      ...sampleInvoice,
      documentType: "creditNote",
      number: "CN-TEST-0002",
      seller: emptyParty,
      buyer: emptyParty,
      lines: [],
      lineCount: 0,
      vatBreakdown: [],
      payments: [],
      notes: [],
    },
  ],
  attachments: [],
} satisfies EInvoicePreview;

// Commits, not render calls: React may call a component more than once for
// one commit, as when a concurrent render yields and restarts, so only the
// renders that reach the screen measure the engines' render budget.
let docxEngineCommitCount = 0;
let pdfEngineCommitCount = 0;

Object.assign(globalThis, {
  recordDocxEngineCommit: () => {
    docxEngineCommitCount += 1;
  },
  recordPdfEngineCommit: () => {
    pdfEngineCommitCount += 1;
  },
});

// The first plugin whose filter matches a module loads it, and the test
// preload has already registered the React Compiler for every source module.
// Clearing it lets the engine stubs register first; the compiler goes back
// after them, so the panel still renders as it ships.
Bun.plugin.clearAll();
Bun.plugin({
  name: "file-tab-rendering-engine-test-loader",
  setup(build) {
    build.onLoad({ filter: /docx-browser-editor\.tsx$/u }, () => ({
      contents: `
        import React from "react";
        export const DocxBrowserEditor = ({ onScrollTopChange }) => {
          React.useLayoutEffect(() => {
            globalThis.recordDocxEngineCommit();
          });
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
        import { usePDFStore } from "@/lib/pdf/pdf-context";
        // Reports how the viewer would draw: the width its pages fit (from
        // the provider), the zoom over it, and whether the wheel zooms.
        export const PDFViewport = ({ onWheelZoom, scaleOffset }) => {
          React.useLayoutEffect(() => {
            globalThis.recordPdfEngineCommit();
          });
          const fitToWidth = usePDFStore((state) => state.fitToWidth);
          return React.createElement("div", {
            "data-fit-width": String(fitToWidth),
            "data-scale-offset": String(scaleOffset ?? 0),
            "data-testid": "pdf-engine",
            "data-wheel-zoom": String(typeof onWheelZoom === "function"),
          });
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
Bun.plugin(reactCompilerBunPlugin);

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { DocxEditorHost } = await import("@/components/docx/docx-editor-host");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { useDocxEditorHostStore } =
  await import("@/components/docx/docx-editor-host-store");
const { FileTabPanel } = await import("./file-tab-panel");
const { dataBoxPreviewOptions, emailHtmlPreviewOptions, fileOptions } =
  await import("@/lib/files/queries");
const {
  asicPreviewOptions,
  cadesPreviewOptions,
  mailboxPreviewOptions,
  signedDossierPreviewOptions,
  zipArchivePreviewOptions,
} = await import("@/lib/files/legal-file-queries");
const { filePartContentOptions } =
  await import("@/lib/files/file-part-queries");
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
  docxEngineCommitCount = 0;
  pdfEngineCommitCount = 0;
  partLinkRequests.length = 0;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

test("native DOCX keeps the host registry and editor inside the render budget", async () => {
  const mounted = renderFileTab(docxTab);
  const engine = await waitFor(() => mounted.getByTestId("docx-engine"));
  expect(engine.isConnected).toBeTrue();
  expect(docxEngineCommitCount).toBe(1);

  const registryAfterMount = useDocxEditorHostStore.getState().registry;
  const claim = Object.values(registryAfterMount).at(0)?.lastClaim;
  if (!claim) {
    throw new Error(
      `The mounted DOCX slot did not publish its host claim: ${JSON.stringify(registryAfterMount)}`,
    );
  }
  expect(claim.bindings.onScrollTopChange).toBeFunction();
  const commitsAfterMount = docxEngineCommitCount;

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
  expect(docxEngineCommitCount - commitsAfterMount).toBeLessThanOrEqual(1);
});

test("PDF keeps the host registry and PDF engine inside the render budget", async () => {
  const mounted = renderFileTab(pdfTab);
  const engine = await waitFor(() => mounted.getByTestId("pdf-engine"));
  expect(engine.isConnected).toBeTrue();
  expect(pdfEngineCommitCount).toBe(1);

  const registryAfterMount = useDocxEditorHostStore.getState().registry;
  const commitsAfterMount = pdfEngineCommitCount;

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
  expect(pdfEngineCommitCount - commitsAfterMount).toBeLessThanOrEqual(1);
});

type DataBoxPreviewData = InferDataFromTag<
  unknown,
  ReturnType<typeof dataBoxPreviewOptions>["queryKey"]
>;

test.each(DATA_BOX_DOCUMENT_KINDS)(
  "opens a ZFO %s in the inspector",
  async (kind) => {
    const tab = {
      ...pdfTab,
      id: toSafeId<"field">("field-data-box"),
      label: "Usnesení o nařízení jednání",
      fileName: "usneseni.ZFO",
      mimeType: "application/octet-stream",
    };
    const party = {
      boxId: "qv7m3kd",
      name: "Okresní soud v Mladé Boleslavi",
      address: null,
      referenceNumber: null,
      fileMark: null,
    };
    const envelope = {
      messageId: "1183520467",
      messageType: "V",
      sender: party,
      recipient: {
        ...party,
        boxId: "h4tq9wz",
        name: "Advokátní kancelář Hrubeš & Šafránek s.r.o.",
      },
      toHands: null,
      personalDelivery: null,
      substituteDelivery: null,
      deliveredAt: "2026-03-01T08:00:00Z",
      acceptedAt: "2026-03-01T10:00:00Z",
      status: "accepted_by_login",
      seal: {
        status: "unverified",
        signerName: null,
        issuerName: null,
        serialNumber: null,
        signedAt: null,
      },
      directionBasis: "unknown",
    } satisfies DataBoxEnvelope;
    const mounted = renderFileTab(tab, (client) => {
      const queryKey = dataBoxPreviewOptions({
        fieldId: tab.id,
        workspaceId: tab.workspaceId,
      }).queryKey;
      const common = {
        annotation: "Usnesení – 9 C 214/2026",
        envelope,
        text: "Usnesení – 9 C 214/2026",
      };
      // A literal passed straight to setQueryData meets its NoInfer'd data
      // union and fails to discriminate; a typed value does not.
      const preview: DataBoxPreviewData =
        kind === "message"
          ? {
              ...common,
              kind,
              files: [
                {
                  part: "attachment:0",
                  fileName: "Usneseni_9C214-2026.pdf",
                  mediaType: "application/pdf",
                  sizeBytes: 48_213,
                  entityId: ENTITY_ID,
                },
                {
                  part: "attachment:1",
                  fileName: "Priloha_c1.docx",
                  mediaType:
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                  sizeBytes: 17_402,
                  entityId: null,
                },
              ],
            }
          : {
              ...common,
              kind,
              events: [
                {
                  occurredAt: envelope.acceptedAt,
                  description: "Message accepted",
                },
              ],
            };
      client.setQueryData(queryKey, preview);
    });
    expect(await mounted.findByText("Usnesení – 9 C 214/2026")).toBeTruthy();
    expect(
      mounted.getByText("Advokátní kancelář Hrubeš & Šafránek s.r.o."),
    ).toBeTruthy();
    expect(
      mounted.getByRole("button", { name: "Download original" }),
    ).toBeTruthy();
    if (kind === "message") {
      // Every file of the message opens in place, filed as a document or not.
      for (const fileName of ["Usneseni_9C214-2026.pdf", "Priloha_c1.docx"]) {
        expect(
          mounted.getByRole("button", { name: `Open ${fileName}` }),
        ).toBeTruthy();
        expect(
          mounted.getByRole("button", { name: `Download ${fileName}` }),
        ).toBeTruthy();
      }
    } else {
      expect(
        mounted.getByRole("heading", { name: "Delivery receipt" }),
      ).toBeTruthy();
      expect(mounted.getByText("Message accepted")).toBeTruthy();
    }
    expect(pdfEngineCommitCount).toBe(0);
  },
);

test.each([
  {
    mimeType: "application/pdf",
    fileName: "submission.pdf",
    text: "",
    textFormat: "markdown",
  },
  {
    mimeType: "text/plain",
    fileName: "submission.txt",
    text: "The enclosed submission",
    textFormat: "plain",
  },
  {
    mimeType: "application/octet-stream",
    fileName: "submission.bin",
    text: "",
    textFormat: "plain",
  },
] as const)(
  "opens a signed container with $mimeType content in the inspector",
  async (embedded) => {
    const tab = {
      ...pdfTab,
      id: toSafeId<"field">("field-cades"),
      label: "Signed submission",
      fileName: "submission.P7M",
      mimeType: "application/octet-stream",
    };
    const key = { fieldId: tab.id, workspaceId: tab.workspaceId };
    const mounted = renderFileTab(tab, (client) => {
      client.setQueryData(cadesPreviewOptions(key).queryKey, {
        ...embedded,
        content: {
          part: "content:0",
          fileName: embedded.fileName,
          mediaType: embedded.mimeType,
          sizeBytes: 4096,
        },
        layers: [
          {
            id: "layer-0",
            signers: [
              { id: "layer-0.signer-0", name: "First signer" },
              { id: "layer-0.signer-1", name: "Second signer" },
            ],
          },
          {
            id: "layer-0.1",
            signers: [{ id: "layer-0.1.signer-0", name: null }],
          },
        ],
        invoice: null,
      });
    });
    expect(
      await mounted.findByRole("heading", { name: embedded.fileName }),
    ).toBeTruthy();
    expect(
      mounted.getByRole("heading", { name: "Signature layer 1" }),
    ).toBeTruthy();
    expect(
      mounted.getByRole("heading", { name: "Signature layer 2" }),
    ).toBeTruthy();
    expect(mounted.getByText("First signer")).toBeTruthy();
    expect(mounted.getByText("Second signer")).toBeTruthy();
    expect(mounted.getByText("Unknown signer")).toBeTruthy();
    expect(
      mounted.getByText("The signatures have not been verified."),
    ).toBeTruthy();
    expect(
      mounted.getByRole("button", { name: "Download original" }),
    ).toBeTruthy();
    expect(
      mounted.getByRole("button", { name: `Open ${embedded.fileName}` }),
    ).toBeTruthy();
    if (embedded.mimeType === "application/pdf") {
      expect(await mounted.findByTestId("pdf-engine")).toBeTruthy();
      expect(partLinkRequests).toEqual(["field-cades/content:0"]);
    } else {
      expect(partLinkRequests).toHaveLength(0);
      expect(pdfEngineCommitCount).toBe(0);
      expect(
        mounted.getByText(
          embedded.text || "No readable content is available for preview.",
        ),
      ).toBeTruthy();
    }
  },
);

const signedPdfTab = {
  ...pdfTab,
  id: toSafeId<"field">("field-cades"),
  label: "Signed submission",
  fileName: "submission.pdf.p7m",
  mimeType: "application/octet-stream",
};

const seedSignedPdf = (client: QueryClientInstance) => {
  client.setQueryData(
    cadesPreviewOptions({
      fieldId: signedPdfTab.id,
      workspaceId: signedPdfTab.workspaceId,
    }).queryKey,
    {
      fileName: "submission.pdf",
      mimeType: "application/pdf",
      text: "",
      textFormat: "markdown",
      content: {
        part: "content:0",
        fileName: "submission.pdf",
        mediaType: "application/pdf",
        sizeBytes: 4096,
      },
      layers: [],
      invoice: null,
    },
  );
};

// The panel stub measures every box at 800 px; the pages fit that width.
const PANEL_WIDTH = "800";

/** How the stubbed PDF engine was asked to draw. */
const drawing = (engine: HTMLElement) => {
  const { fitWidth, scaleOffset, wheelZoom } = engine.dataset;
  return { fitWidth, scaleOffset, wheelZoom };
};

test("draws a signed file's PDF as a PDF tab draws its own", async () => {
  const plain = renderFileTab(pdfTab);
  expect(drawing(await plain.findByTestId("pdf-engine"))).toEqual({
    fitWidth: PANEL_WIDTH,
    scaleOffset: "0",
    wheelZoom: "true",
  });
  await act(async () => {
    cleanup();
  });

  const signed = renderFileTab(signedPdfTab, seedSignedPdf);
  // Fits the panel, zooms with the wheel, and follows the same controls.
  expect(drawing(await signed.findByTestId("pdf-engine"))).toEqual({
    fitWidth: PANEL_WIDTH,
    scaleOffset: "0",
    wheelZoom: "true",
  });
  await act(async () => {
    fireEvent.click(signed.getByRole("button", { name: "Zoom in" }));
  });
  expect(drawing(signed.getByTestId("pdf-engine")).scaleOffset).toBe("0.25");
});

test("reopens a signed file's PDF from the cache without fetching it again", async () => {
  const mounted = renderFileTab(signedPdfTab, seedSignedPdf);
  expect(await mounted.findByTestId("pdf-engine")).toBeTruthy();
  expect(partLinkRequests).toHaveLength(1);

  await act(async () => {
    fireEvent.click(mounted.getByTestId("toggle-panel"));
  });
  expect(mounted.queryByTestId("pdf-engine")).toBeNull();
  // A closed tab keeps the extracted bytes as long as a file keeps its own,
  // not until the next tick.
  const cache = mounted.queryClient.getQueryCache();
  const signedBytes = cache.find({
    queryKey: filePartContentOptions({
      fieldId: signedPdfTab.id,
      workspaceId: signedPdfTab.workspaceId,
      part: "content:0",
    }).queryKey,
  });
  const fileBytes = cache.find({
    queryKey: fileOptions({
      fieldId: signedPdfTab.id,
      workspaceId: signedPdfTab.workspaceId,
    }).queryKey,
  });
  expect(signedBytes?.getObserversCount()).toBe(0);
  expect(signedBytes?.gcTime).toBeGreaterThan(0);
  expect(signedBytes?.gcTime).toBe(fileBytes?.gcTime);
  await act(async () => {
    fireEvent.click(mounted.getByTestId("toggle-panel"));
  });

  // Present in the same commit as the reopen: no loading state in between.
  expect(mounted.getByTestId("pdf-engine")).toBeTruthy();
  expect(partLinkRequests).toHaveLength(1);
});

test("keeps the original available when the signed container cannot be opened", async () => {
  const mounted = renderFileTab({
    ...pdfTab,
    id: toSafeId<"field">("field-cades-unsupported"),
    fileName: "detached.p7m",
    mimeType: "application/octet-stream",
  });
  expect(
    await mounted.findByText("The signed file could not be read."),
  ).toBeTruthy();
  expect(
    mounted.getByRole("button", { name: "Download original" }),
  ).toBeTruthy();
  expect(pdfEngineCommitCount).toBe(0);
});

test.each([".asice", ".asics"])(
  "lists the files of a signed %s archive and opens each in place",
  async (extension) => {
    const tab = {
      ...pdfTab,
      id: toSafeId<"field">("field-asic"),
      fileName: `toovotuleping${extension}`,
      mimeType: "application/octet-stream",
    };
    const key = { fieldId: tab.id, workspaceId: tab.workspaceId };
    const mounted = renderFileTab(tab, (client) => {
      client.setQueryData(asicPreviewOptions(key).queryKey, {
        members: [
          {
            part: "member:0",
            fileName: "leping.html",
            mediaType: "text/html",
            sizeBytes: 21_504,
            status: "readable",
            text: "# Töövõtuleping\n\n**2. Tasu**\n\nTöövõtja saab tasu",
            textFormat: "markdown",
          },
          {
            part: "member:1",
            fileName: "lisa.pdf",
            mediaType: "application/pdf",
            sizeBytes: 88_310,
            status: "readable",
            text: "Lisa 1",
            textFormat: "markdown",
          },
          {
            part: "member:2",
            fileName: "markused.txt",
            mediaType: "text/plain",
            sizeBytes: 31,
            status: "readable",
            text: "# První strana",
            textFormat: "plain",
          },
        ],
      });
    });

    for (const fileName of ["leping.html", "lisa.pdf", "markused.txt"]) {
      expect(
        await mounted.findByRole("button", { name: `Open ${fileName}` }),
      ).toBeTruthy();
      expect(
        mounted.getByRole("button", { name: `Download ${fileName}` }),
      ).toBeTruthy();
    }
    expect(
      mounted.getByText("The signatures have not been verified."),
    ).toBeTruthy();
    expect(
      mounted.getByRole("button", { name: "Download original" }),
    ).toBeTruthy();
    expect(pdfEngineCommitCount).toBe(0);
    expect(partLinkRequests).toHaveLength(0);

    // A document without a preview of its own shows what it is and the text
    // the server read from it, formatted, never as Markdown source.
    fireEvent.click(mounted.getByRole("button", { name: "Open leping.html" }));
    expect(
      await mounted.findByRole("heading", { name: "Töövõtuleping" }),
    ).toBeTruthy();
    expect(mounted.getByText("2. Tasu")).toBeTruthy();
    expect(mounted.queryByText(/\*\*|^# Töö/u)).toBeNull();
    expect(partLinkRequests).toHaveLength(0);
    fireEvent.click(mounted.getByRole("button", { name: "Back to the list" }));

    // A PDF opens in the PDF viewer, a text file as its own characters.
    fireEvent.click(mounted.getByRole("button", { name: "Open lisa.pdf" }));
    expect(await mounted.findByTestId("pdf-engine")).toBeTruthy();
    fireEvent.click(mounted.getByRole("button", { name: "Back to the list" }));
    fireEvent.click(mounted.getByRole("button", { name: "Open markused.txt" }));
    const plain = await mounted.findByText(/^# První strana/u);
    expect(plain.tagName).toBe("PRE");
    expect(plain.textContent).toBe("# První strana\nDruhý řádek");
    expect(partLinkRequests).toEqual([
      "field-asic/member:1",
      "field-asic/member:2",
    ]);
  },
);

test("lists a ZIP archive's files with their folders and opens an email inside it in place", async () => {
  const tab = {
    ...pdfTab,
    id: toSafeId<"field">("field-zip"),
    fileName: "podklady-ke-sporu.zip",
    mimeType: "application/zip",
  };
  const key = { fieldId: tab.id, workspaceId: tab.workspaceId };
  const unread = {
    text: "",
    textFormat: "plain",
    status: "unavailable",
  } as const;
  const mounted = renderFileTab(tab, (client) => {
    client.setQueryData(zipArchivePreviewOptions(key).queryKey, {
      files: [
        {
          fileName: "žaloba.pdf",
          folder: "podání/2026",
          sizeBytes: 88_310,
          part: {
            part: "member:0",
            fileName: "žaloba.pdf",
            mediaType: "application/pdf",
            sizeBytes: 88_310,
          },
          unavailable: null,
          text: "Žaloba",
          textFormat: "markdown",
          status: "readable",
        },
        {
          fileName: "posudek.pdf",
          folder: null,
          sizeBytes: 120_400,
          part: null,
          unavailable: "encrypted",
          ...unread,
        },
        {
          fileName: "podklady.eml",
          folder: "korespondence",
          sizeBytes: 9120,
          part: {
            part: "member:2",
            fileName: "podklady.eml",
            mediaType: "message/rfc822",
            sizeBytes: 9120,
          },
          unavailable: null,
          ...unread,
        },
      ],
    });
    client.setQueryData(
      emailHtmlPreviewOptions({ ...key, part: "member:2" }).queryKey,
      {
        attachments: [
          {
            charset: null,
            part: "member:2/attachment:0",
            fileName: "usneseni.pdf",
            mediaType: "application/pdf",
            sizeBytes: 4210,
          },
        ],
        bcc: [],
        bodyFolds: [],
        bodyHtml: "<p>Dobrý den, v příloze posílám usnesení.</p>",
        certified: null,
        citationBlocks: [],
        cc: [],
        date: "Tue, 17 Nov 2026 09:30:00 +0100",
        from: "Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
        source: {
          entityId: toSafeId<"entity">("entity-zip"),
          entityName: "Podklady ke sporu",
          fieldId: toSafeId<"field">("field-zip"),
          fileName: "podklady-ke-sporu.zip",
          mimeType: "application/zip",
          pdfFileId: null,
          propertyId: toSafeId<"property">("property-zip"),
        },
        subject: "Podklady k jednání",
        to: ["Jitka Skořepová <skorepova@stavby-hradec.cz>"],
      },
    );
  });

  expect(
    await mounted.findByRole("button", { name: "Open žaloba.pdf" }),
  ).toBeTruthy();
  expect(mounted.getByText("podání/2026")).toBeTruthy();
  // A locked file is listed with the reason, and nothing opens it.
  expect(mounted.getByText("Password-protected, can’t be opened")).toBeTruthy();
  expect(
    mounted.queryByRole("button", { name: "Open posudek.pdf" }),
  ).toBeNull();
  expect(
    mounted.queryByRole("button", { name: "Download posudek.pdf" }),
  ).toBeNull();

  // An email in the archive opens as an email, its attachments in turn.
  fireEvent.click(mounted.getByRole("button", { name: "Open podklady.eml" }));
  expect(
    await mounted.findByRole("heading", { name: "Podklady k jednání" }),
  ).toBeTruthy();
  fireEvent.click(
    await mounted.findByRole("button", { name: /usneseni\.pdf/u }),
  );
  expect(await mounted.findByTestId("pdf-engine")).toBeTruthy();
  expect(partLinkRequests).toContain("field-zip/member:2/attachment:0");
  fireEvent.click(mounted.getByRole("button", { name: "Back to the list" }));
  expect(
    await mounted.findByRole("heading", { name: "Podklady k jednání" }),
  ).toBeTruthy();
  fireEvent.click(mounted.getByRole("button", { name: "Back to the list" }));
  expect(
    await mounted.findByRole("button", { name: "Open žaloba.pdf" }),
  ).toBeTruthy();
  expect(partLinkRequests).not.toContain("field-zip/member:2");
});

test("lists a mailbox's messages and opens one in place as an email", async () => {
  const tab = {
    ...pdfTab,
    id: toSafeId<"field">("field-mbox"),
    fileName: "spis-23-C-118-2026.mbox",
    mimeType: "application/octet-stream",
  };
  const key = { fieldId: tab.id, workspaceId: tab.workspaceId };
  const mounted = renderFileTab(tab, (client) => {
    client.setQueryData(mailboxPreviewOptions(key).queryKey, {
      truncated: false,
      messages: [
        {
          fileName: "Plná moc a výzva.eml",
          folder: "Spisy/Stavby Hradec",
          sizeBytes: 9120,
          subject: "Plná moc a výzva",
          from: "Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
          date: "not a date",
          part: {
            part: "message:0",
            fileName: "Plná moc a výzva.eml",
            mediaType: "message/rfc822",
            sizeBytes: 9120,
          },
          unavailable: null,
        },
        {
          fileName: "spis-23-C-118-2026-2.eml",
          folder: null,
          sizeBytes: 40_000_000,
          subject: null,
          from: null,
          date: null,
          part: null,
          unavailable: "tooLarge",
        },
      ],
    });
    client.setQueryData(
      emailHtmlPreviewOptions({ ...key, part: "message:0" }).queryKey,
      {
        attachments: [
          {
            charset: null,
            part: "message:0/attachment:0",
            fileName: "plna-moc.pdf",
            mediaType: "application/pdf",
            sizeBytes: 4210,
          },
        ],
        bcc: [],
        bodyFolds: [],
        bodyHtml: "<p>Dobrý den, v příloze posílám plnou moc.</p>",
        certified: null,
        citationBlocks: [],
        cc: [],
        date: "Thu, 19 Nov 2026 10:15:00 +0100",
        from: "Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
        source: {
          entityId: toSafeId<"entity">("entity-mbox"),
          entityName: "Korespondence",
          fieldId: toSafeId<"field">("field-mbox"),
          fileName: "spis-23-C-118-2026.mbox",
          mimeType: "application/octet-stream",
          pdfFileId: null,
          propertyId: toSafeId<"property">("property-mbox"),
        },
        subject: "Plná moc a výzva",
        to: ["Jitka Skořepová <skorepova@stavby-hradec.cz>"],
      },
    );
  });

  // Each message shows who sent it, when (as stated) and where it was filed.
  expect(
    await mounted.findByText(
      "Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz> · not a date · Spisy/Stavby Hradec",
    ),
  ).toBeTruthy();
  // One too large to open is listed with why, and nothing opens it.
  expect(mounted.getByText("(No subject)")).toBeTruthy();
  expect(mounted.getByText("Too large to open")).toBeTruthy();
  expect(
    mounted.queryByRole("button", { name: "Open (No subject)" }),
  ).toBeNull();

  fireEvent.click(
    mounted.getByRole("button", { name: "Open Plná moc a výzva" }),
  );
  expect(
    await mounted.findByRole("heading", { name: "Plná moc a výzva" }),
  ).toBeTruthy();
  fireEvent.click(
    await mounted.findByRole("button", { name: /plna-moc\.pdf/u }),
  );
  expect(await mounted.findByTestId("pdf-engine")).toBeTruthy();
  expect(partLinkRequests).toContain("field-mbox/message:0/attachment:0");
  // Opening a message reads nothing more than its preview.
  expect(partLinkRequests).not.toContain("field-mbox/message:0");
});

test("opens a document member no viewer draws as the PDF the server converts it to", async () => {
  const tab = {
    ...pdfTab,
    id: toSafeId<"field">("field-asic-converted"),
    fileName: "toovotuleping.asice",
    mimeType: "application/octet-stream",
  };
  const key = { fieldId: tab.id, workspaceId: tab.workspaceId };
  const mounted = renderFileTab(tab, (client) => {
    client.setQueryData(asicPreviewOptions(key).queryKey, {
      members: [
        {
          part: "member:0",
          fileName: "leping.odt",
          mediaType: "application/vnd.oasis.opendocument.text",
          sizeBytes: 18_944,
          status: "readable",
          text: "Töövõtuleping",
          textFormat: "plain",
        },
        {
          part: "member:1",
          fileName: "lisa.doc",
          mediaType: "application/msword",
          sizeBytes: 26_112,
          status: "readable",
          text: "Lisa 1",
          textFormat: "plain",
        },
      ],
    });
  });

  // The OpenDocument text opens in the PDF viewer, as its stored kind does.
  fireEvent.click(
    await mounted.findByRole("button", { name: "Open leping.odt" }),
  );
  expect(await mounted.findByTestId("pdf-engine")).toBeTruthy();
  expect(partLinkRequests).toEqual(["field-asic-converted/member:0"]);
  fireEvent.click(mounted.getByRole("button", { name: "Back to the list" }));

  // A document the server could not convert says so and stays downloadable.
  fireEvent.click(mounted.getByRole("button", { name: "Open lisa.doc" }));
  expect(
    await mounted.findByText(
      "This file couldn't be converted for preview. Download it or save it to a matter.",
    ),
  ).toBeTruthy();
  expect(
    mounted.getAllByRole("button", { name: "Download lisa.doc" }).length,
  ).toBeGreaterThan(0);
});

test("keeps the original ASiC archive available when preview is unavailable", async () => {
  const mounted = renderFileTab({
    ...pdfTab,
    id: toSafeId<"field">("field-asic-unsupported"),
    fileName: "unsupported.asice",
    mimeType: "application/octet-stream",
  });
  expect(
    await mounted.findByText("The signed file could not be read."),
  ).toBeTruthy();
  expect(
    mounted.getByRole("button", { name: "Download original" }),
  ).toBeTruthy();
});

test("isolates member names in the Arabic ASiC preview", async () => {
  const tab = {
    ...pdfTab,
    id: toSafeId<"field">("field-asic-arabic"),
    fileName: "submission.asice",
    mimeType: "application/octet-stream",
  };
  const fileName = "Appendix ٢.pdf";
  const mounted = renderFileTab(
    tab,
    (client) => {
      const key = { fieldId: tab.id, workspaceId: tab.workspaceId };
      client.setQueryData(asicPreviewOptions(key).queryKey, {
        members: [
          {
            part: "member:0",
            fileName,
            mediaType: "application/pdf",
            sizeBytes: 1024,
            status: "truncated",
            text: "جزء من المستند",
            textFormat: "plain",
          },
        ],
      });
    },
    "ar",
  );
  const name = await mounted.findByText(fileName);
  expect(name.getAttribute("dir")).toBe("auto");
  expect(name.closest('[dir="rtl"]')).toBeTruthy();
});

test.each([".es3", ".et3", ".dosszie", ".zep", ".xzep"])(
  "lists the signers and documents of a %s container and previews its PDFs",
  async (extension) => {
    const tab = {
      ...pdfTab,
      id: toSafeId<"field">("field-dossier"),
      fileName: `podanie${extension}`,
      mimeType: "application/octet-stream",
    };
    const key = { fieldId: tab.id, workspaceId: tab.workspaceId };
    const mounted = renderFileTab(tab, (client) => {
      client.setQueryData(signedDossierPreviewOptions(key).queryKey, {
        receipt: extension === ".et3",
        signers: [
          { id: "signature-0", name: "Fekete Zsófia" },
          { id: "signature-1", name: null },
        ],
        documents: [
          {
            id: "document-0",
            fileName: "kérelem.txt",
            status: "readable",
            text: "Kérelem szövege",
            textFormat: "plain",
            part: {
              part: "document:0",
              fileName: "kérelem.txt",
              mediaType: "text/plain",
              sizeBytes: 15,
            },
          },
          {
            id: "document-1",
            fileName: "végzés.pdf",
            status: "readable",
            text: "Végzés",
            textFormat: "markdown",
            part: {
              part: "document:1",
              fileName: "végzés.pdf",
              mediaType: "application/pdf",
              sizeBytes: 52_118,
            },
          },
          {
            id: "document-2",
            fileName: "csomag.zip",
            status: "unavailable",
            text: "",
            textFormat: "plain",
            part: null,
          },
          {
            id: "document-3",
            fileName: "melléklet.pdf",
            status: "unavailable",
            text: "",
            textFormat: "markdown",
            part: {
              part: "document:3",
              fileName: "melléklet.pdf",
              mediaType: "application/pdf",
              sizeBytes: 9870,
            },
          },
        ],
      });
    });

    expect(
      await mounted.findByRole("button", { name: "Open kérelem.txt" }),
    ).toBeTruthy();
    expect(mounted.getByText("Fekete Zsófia")).toBeTruthy();
    expect(
      mounted.queryByRole("heading", {
        name: "Delivery receipt for an electronic dossier",
      }) !== null,
    ).toBe(extension === ".et3");
    expect(mounted.getByText("Unknown signer")).toBeTruthy();
    expect(
      mounted.getByText("The signatures have not been verified."),
    ).toBeTruthy();
    // A document the container keeps unreadable is named, not offered.
    expect(mounted.getByText("csomag.zip")).toBeTruthy();
    expect(
      mounted.queryByRole("button", { name: "Open csomag.zip" }),
    ).toBeNull();
    // The first PDF opens at once; any document opens in place from the list.
    expect(await mounted.findByTestId("pdf-engine")).toBeTruthy();
    fireEvent.click(
      mounted.getByRole("button", { name: "Open melléklet.pdf" }),
    );
    await waitFor(() => {
      expect(partLinkRequests).toEqual([
        "field-dossier/document:1",
        "field-dossier/document:3",
      ]);
    });
    fireEvent.click(mounted.getByRole("button", { name: "Back to the list" }));
    expect(
      mounted.getByRole("button", { name: "Download original" }),
    ).toBeTruthy();
  },
);

test("keeps the original signed container available when preview is unavailable", async () => {
  const mounted = renderFileTab({
    ...pdfTab,
    id: toSafeId<"field">("field-dossier-unsupported"),
    fileName: "podanie.zep",
    mimeType: "application/zip",
  });
  expect(
    await mounted.findByText("The signed file could not be read."),
  ).toBeTruthy();
  expect(
    mounted.getByRole("button", { name: "Download original" }),
  ).toBeTruthy();
  expect(pdfEngineCommitCount).toBe(0);
});

test.each([".udf", ".ofd"])(
  "renders a %s text preview with its original download",
  async (extension) => {
    const mounted = renderFileTab(
      {
        ...pdfTab,
        id: toSafeId<"field">("field-structured"),
        fileName: `submission${extension}`,
        mimeType: "application/octet-stream",
      },
      undefined,
      "ar",
    );

    const text = await mounted.findByText("İlk sayfa 法院文件");
    expect(text.getAttribute("dir")).toBe("auto");
    expect(text.closest('[dir="rtl"]')).toBeTruthy();
    expect(
      mounted.getByText(arabicMessages.common.previewTruncated),
    ).toBeTruthy();
    expect(
      mounted.getByText(arabicMessages.structuredDocument.textOnly),
    ).toBeTruthy();
    expect(
      mounted.getByRole("button", {
        name: arabicMessages.common.downloadOriginal,
      }),
    ).toBeTruthy();
    expect(pdfEngineCommitCount).toBe(0);
  },
);

test.each([".udf", ".ofd"])(
  "keeps the %s original available when no text can be previewed",
  async (extension) => {
    const mounted = renderFileTab({
      ...pdfTab,
      id: toSafeId<"field">("field-preview-unavailable"),
      fileName: `submission${extension}`,
      mimeType: "application/octet-stream",
    });
    expect(
      await mounted.findByText("No readable text is available for preview."),
    ).toBeTruthy();
    expect(
      mounted.getByRole("button", { name: "Download original" }),
    ).toBeTruthy();
  },
);

test.each([
  { extension: ".isdoc", mimeType: "application/octet-stream" },
  { extension: ".xml", mimeType: "application/xml" },
])(
  "renders a $extension structured invoice with its parties and totals",
  async ({ extension, mimeType }) => {
    const mounted = renderFileTab({
      ...pdfTab,
      id: toSafeId<"field">("field-e-invoice-single"),
      fileName: `INV-TEST-0001${extension}`,
      mimeType,
    });

    expect(
      await mounted.findByRole("heading", { name: "Invoice INV-TEST-0001" }),
    ).toBeTruthy();
    expect(mounted.getByText("ISDOC, version 6.0.2")).toBeTruthy();
    expect(mounted.getByRole("heading", { name: "Supplier" })).toBeTruthy();
    expect(mounted.getByText("Sample Supplier Test")).toBeTruthy();
    expect(mounted.getByText("Sample Customer Test")).toBeTruthy();
    expect(mounted.getByText("XX0000000001")).toBeTruthy();
    expect(mounted.getByText("Registration number (GLN)")).toBeTruthy();
    expect(mounted.getByText("Sample consulting hours")).toBeTruthy();
    // Common units are named in words, with the plural their count takes.
    expect(mounted.getByText("10.000 hours")).toBeTruthy();
    expect(mounted.getByText("1 hour")).toBeTruthy();
    expect(mounted.getByText("Showing 1 of 3 lines")).toBeTruthy();
    expect(mounted.getAllByText("21% (S)")).toHaveLength(2);
    expect(mounted.getByText("Total with VAT")).toBeTruthy();
    expect(mounted.getAllByText("1210.00 CZK")).toHaveLength(2);
    expect(mounted.getByText("XX00TEST0000000000000001")).toBeTruthy();
    expect(mounted.getByText("Sample note")).toBeTruthy();
    // A total the file does not state is left out, not shown as empty.
    expect(mounted.queryByText("Paid in advance")).toBeNull();
    expect(mounted.getByText("vykaz-prace-rijen-2026.pdf")).toBeTruthy();
    expect(mounted.getByText("Výkaz práce za říjen 2026")).toBeTruthy();
    expect(
      mounted.getByRole("button", {
        name: "Download vykaz-prace-rijen-2026.pdf",
      }),
    ).toBeTruthy();
    // The attachment opens in place, through the invoice file's part link.
    fireEvent.click(
      mounted.getByRole("button", { name: "Open vykaz-prace-rijen-2026.pdf" }),
    );
    expect(await mounted.findByTestId("pdf-engine")).toBeTruthy();
    expect(partLinkRequests).toEqual(["field-e-invoice-single/attachment:0"]);
    fireEvent.click(mounted.getByRole("button", { name: "Back to the list" }));
    expect(
      mounted.getByRole("button", { name: "Download original" }),
    ).toBeTruthy();
  },
);

test("shows each invoice of an Italian batch under its own heading", async () => {
  const mounted = renderFileTab({
    ...pdfTab,
    id: toSafeId<"field">("field-e-invoice-batch"),
    fileName: "IT00000000000_TEST1.xml",
    mimeType: "text/xml",
  });

  expect(
    await mounted.findByRole("heading", { name: "Invoice INV-TEST-0001" }),
  ).toBeTruthy();
  expect(
    mounted.getByRole("heading", { name: "Credit note CN-TEST-0002" }),
  ).toBeTruthy();
  expect(mounted.getByText("FatturaPA, version FPR12")).toBeTruthy();
  expect(mounted.getByText("Document 1 of 2")).toBeTruthy();
  expect(mounted.getByText("Document 2 of 2")).toBeTruthy();
  // The credit note states no lines, so it has no line table of its own.
  expect(mounted.getAllByRole("heading", { name: "Line items" })).toHaveLength(
    1,
  );
});

test.each([
  {
    extension: ".xml",
    message: "This XML file is not a recognized structured invoice.",
  },
  { extension: ".isdoc", message: "The invoice could not be read." },
  { extension: ".isdocx", message: "The invoice could not be read." },
])(
  "keeps the $extension original available when no invoice can be read",
  async ({ extension, message }) => {
    const mounted = renderFileTab({
      ...pdfTab,
      id: toSafeId<"field">("field-e-invoice-refused"),
      fileName: `document${extension}`,
      mimeType: "application/octet-stream",
    });
    expect(await mounted.findByText(message)).toBeTruthy();
    expect(
      mounted.getByRole("button", { name: "Download original" }),
    ).toBeTruthy();
    expect(pdfEngineCommitCount).toBe(0);
  },
);

test("reads the invoice inside a signed FatturaPA file", async () => {
  const tab = {
    ...pdfTab,
    id: toSafeId<"field">("field-cades-invoice"),
    label: "Signed invoice",
    fileName: "IT00000000000_TEST1.xml.p7m",
    mimeType: "application/pkcs7-mime",
  };
  const key = { fieldId: tab.id, workspaceId: tab.workspaceId };
  const mounted = renderFileTab(tab, (client) => {
    client.setQueryData(cadesPreviewOptions(key).queryKey, {
      fileName: "IT00000000000_TEST1.xml",
      mimeType: "application/xml",
      text: "<FatturaElettronica>raw source</FatturaElettronica>",
      textFormat: "plain",
      content: {
        part: "content:0",
        fileName: "IT00000000000_TEST1.xml",
        mediaType: "application/xml",
        sizeBytes: 8192,
      },
      layers: [
        {
          id: "layer-0",
          signers: [{ id: "layer-0.signer-0", name: "Sample signer" }],
        },
      ],
      invoice: invoiceBatchPreview,
    });
  });

  expect(
    await mounted.findByRole("heading", { name: "Invoice INV-TEST-0001" }),
  ).toBeTruthy();
  expect(mounted.getByText("Sample signer")).toBeTruthy();
  expect(
    mounted.getByText("The signatures have not been verified."),
  ).toBeTruthy();
  expect(mounted.getAllByText("Total with VAT")).toHaveLength(2);
  // The invoice replaces the raw source text.
  expect(
    mounted.queryByText("<FatturaElettronica>raw source</FatturaElettronica>"),
  ).toBeNull();
  expect(partLinkRequests).toHaveLength(0);
});

function renderFileTab(
  tab: typeof docxTab | typeof pdfTab,
  seed?: (client: QueryClientInstance) => void,
  locale: "ar" | "en" = "en",
) {
  const messages = locale === "ar" ? arabicMessages : bundledEnglishMessages;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  seed?.(queryClient);
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
    const [scaleOffsets, setScaleOffsets] = React.useState(
      new Map<string, number>(),
    );
    const [panelOpen, setPanelOpen] = React.useState(true);
    const zoom = (tabId: string, direction: "in" | "out") =>
      setScaleOffsets((current) =>
        new Map(current).set(
          tabId,
          (current.get(tabId) ?? 0) + (direction === "in" ? 0.25 : -0.25),
        ),
      );

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
          <IntlProvider locale={locale} messages={messages} timeZone="UTC">
            <FormattingProvider locale={locale} timeZone="UTC">
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
              <button
                data-testid="toggle-panel"
                onClick={() => setPanelOpen((open) => !open)}
                type="button"
              >
                {bundledEnglishMessages.common.retry}
              </button>
              {panelOpen && (
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
                  handleZoom={zoom}
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
              )}
            </FormattingProvider>
          </IntlProvider>
        </AuthenticatedUserProvider>
      </QueryClientProvider>
    );
  };

  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale={locale} messages={messages} timeZone="UTC">
        <DocxEditorHost />
      </IntlProvider>
    </QueryClientProvider>,
  );
  const router = createRouter({
    routeTree: createRootRoute({ component: Harness }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const rendered = render(
    <div dir={locale === "ar" ? "rtl" : "ltr"}>
      <RouterProvider router={router} />
    </div>,
  );
  return Object.assign(rendered, { queryClient });
}
