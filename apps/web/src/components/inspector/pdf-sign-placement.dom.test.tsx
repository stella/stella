import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";

import type { PdfSignTarget } from "@/components/inspector/pdf-sign-action";
import type { PdfSigningStamp } from "@/components/inspector/pdf-signing-stamp.logic";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceEntity } from "@/lib/types";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { stellaToast, ToastProvider } = await import("@stll/ui/toast");
const { usePdfSignFromList } =
  await import("@/components/inspector/pdf-sign-action");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");
const { PdfSignPlacementControls, PdfSignPlacementPage } =
  await import("@/components/inspector/pdf-sign-placement");
const { beginPdfSignPlacement, endPdfSignPlacement, usePdfSignPlacementStore } =
  await import("@/components/inspector/pdf-sign-placement-store");
const { STAMP_LIMITS_PT } =
  await import("@/components/inspector/pdf-signing-stamp.logic");
const en = (await import("@/i18n/langs/en.json")).default;

const initialInspectorTabs = useInspectorTabsStore.getState();

afterEach(async () => {
  await act(async () => {
    stellaToast.close();
  });
  cleanup();
  endPdfSignPlacement();
  useInspectorTabsStore.setState(initialInspectorTabs, true);
  mock.restore();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const strings = en.workspaces.files.pdfSigning;
const A4 = { height: 841.89, width: 595.28 } as const;
const FIELD_ID = "a0123344-5566-7788-9900-aabbccddeeff";
// The third page: the stamp records which page it was drawn on.
const PAGE_INDEX = 2;
const POINTER = 7;

/** What a viewer renders while its file's stamp is being placed. */
const Viewer = ({ onPlaceOnLastPage }: { onPlaceOnLastPage: () => void }) => {
  const isPlacing = usePdfSignPlacementStore(
    (state) => state.session?.fieldId === FIELD_ID,
  );
  if (!isPlacing) {
    return null;
  }
  return (
    <>
      <PdfSignPlacementControls
        onPlaceOnLastPage={onPlaceOnLastPage}
        showsOwnPages
      />
      <PdfSignPlacementPage page={A4} pageIndex={PAGE_INDEX} />
    </>
  );
};

const mount = () => {
  const confirmed: (PdfSigningStamp | undefined)[] = [];
  const lastPagePlacements: string[] = [];
  render(
    <IntlProvider locale="en" messages={en} timeZone="UTC">
      <Viewer
        onPlaceOnLastPage={() => {
          lastPagePlacements.push("last");
        }}
      />
    </IntlProvider>,
  );
  act(() => {
    beginPdfSignPlacement({
      cancel: () => undefined,
      confirm: (stamp) => {
        confirmed.push(stamp);
      },
      fieldId: FIELD_ID,
      isCurrent: () => true,
    });
  });
  const surface =
    document.querySelector<HTMLElement>(
      `[data-pdf-sign-placement-page="${String(PAGE_INDEX + 1)}"]`,
    ) ?? panic("The page surface is missing");
  // One CSS pixel per point: the page is drawn at its own size.
  Object.assign(surface, {
    getBoundingClientRect: () => new DOMRect(0, 0, A4.width, A4.height),
    setPointerCapture: () => undefined,
  });
  return { confirmed, lastPagePlacements, surface };
};

const button = (name: string) => screen.getByRole("button", { name });
const queryButton = (name: string) => screen.queryByRole("button", { name });
const preview = () =>
  document.querySelector<HTMLElement>("[data-stamp-preview]");

const drag = (
  surface: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
) => {
  fireEvent.pointerDown(surface, {
    button: 0,
    clientX: from.x,
    clientY: from.y,
    pointerId: POINTER,
  });
  fireEvent.pointerMove(surface, {
    clientX: to.x,
    clientY: to.y,
    pointerId: POINTER,
  });
};

test("entering placement offers the page and waits for a stamp before signing with one", () => {
  mount();

  expect(screen.getByText(strings.placementModeHint)).toBeDefined();
  expect(button(strings.placementSignVisible).hasAttribute("disabled")).toBe(
    true,
  );
  expect(button(strings.placementSignInvisible).hasAttribute("disabled")).toBe(
    false,
  );
  expect(queryButton(strings.placementBox)).toBeNull();
});

test("a drag previews the box, flags it while too small, and leaves a stamp within the limits", () => {
  const { confirmed, surface } = mount();

  drag(surface, { x: 100, y: 200 }, { x: 130, y: 210 });
  expect(preview()?.dataset["stampPreview"]).toBe("too_small");
  expect(screen.getByText(strings.placementDrawTooSmall)).toBeDefined();

  fireEvent.pointerMove(surface, {
    clientX: 300,
    clientY: 260,
    pointerId: POINTER,
  });
  expect(preview()?.dataset["stampPreview"]).toBe("fits");
  expect(screen.getByText(strings.placementModeHint)).toBeDefined();

  fireEvent.pointerUp(surface, { pointerId: POINTER });
  expect(preview()).toBeNull();
  expect(button(strings.placementBox)).toBeDefined();
  expect(screen.getByText(strings.placementRedrawHint)).toBeDefined();
  expect(confirmed).toEqual([]);

  fireEvent.click(button(strings.placementSignVisible));

  expect(confirmed).toHaveLength(1);
  const stamp = confirmed[0] ?? panic("No stamp was confirmed");
  expect(stamp.pageIndex).toBe(PAGE_INDEX);
  expect(stamp.box.x * A4.width).toBeCloseTo(100, 6);
  expect(stamp.box.y * A4.height).toBeCloseTo(200, 6);
  expect(stamp.box.width * A4.width).toBeCloseTo(200, 6);
  expect(stamp.box.height * A4.height).toBeCloseTo(60, 6);
  expect(stamp.labels.signedBy).toBe(strings.stampSignedBy);
  // Confirming ends placement.
  expect(queryButton(strings.placementSignVisible)).toBeNull();
});

test("a box released too large is brought down to the largest stamp", () => {
  const { confirmed, surface } = mount();

  drag(surface, { x: 20, y: 40 }, { x: 590, y: 800 });
  expect(preview()?.dataset["stampPreview"]).toBe("too_large");
  expect(screen.getByText(strings.placementDrawTooLarge)).toBeDefined();
  fireEvent.pointerUp(surface, { pointerId: POINTER });
  fireEvent.click(button(strings.placementSignVisible));

  const stamp = confirmed[0] ?? panic("No stamp was confirmed");
  expect(stamp.box.x * A4.width).toBeCloseTo(20, 6);
  expect(stamp.box.width * A4.width).toBeCloseTo(STAMP_LIMITS_PT.maxWidth, 6);
  expect(stamp.box.height * A4.height).toBeCloseTo(
    STAMP_LIMITS_PT.maxHeight,
    6,
  );
});

test("a cancelled pointer leaves no stamp behind", () => {
  const { surface } = mount();

  drag(surface, { x: 100, y: 200 }, { x: 300, y: 260 });
  fireEvent.pointerCancel(surface, { pointerId: POINTER });

  expect(preview()).toBeNull();
  expect(queryButton(strings.placementBox)).toBeNull();
  expect(button(strings.placementSignVisible).hasAttribute("disabled")).toBe(
    true,
  );
});

test("Escape cancels placement without signing", () => {
  const { confirmed, surface } = mount();
  drag(surface, { x: 100, y: 200 }, { x: 300, y: 260 });
  fireEvent.pointerUp(surface, { pointerId: POINTER });

  fireEvent.keyDown(document, { key: "Escape" });

  expect(queryButton(strings.placementSignVisible)).toBeNull();
  expect(usePdfSignPlacementStore.getState().session).toBeNull();
  expect(confirmed).toEqual([]);
});

test("Cancel leaves placement without signing", () => {
  const { confirmed } = mount();

  fireEvent.click(button(en.common.cancel));

  expect(usePdfSignPlacementStore.getState().session).toBeNull();
  expect(confirmed).toEqual([]);
});

test("signing without a stamp hands over no stamp", () => {
  const { confirmed } = mount();

  fireEvent.click(button(strings.placementSignInvisible));

  expect(confirmed).toEqual([undefined]);
  expect(usePdfSignPlacementStore.getState().session).toBeNull();
});

test("the keyboard way to place a stamp is offered until one is drawn", () => {
  const { lastPagePlacements, surface } = mount();

  fireEvent.click(button(strings.placementPlaceOnLastPage));
  expect(lastPagePlacements).toEqual(["last"]);

  drag(surface, { x: 100, y: 200 }, { x: 300, y: 260 });
  fireEvent.pointerUp(surface, { pointerId: POINTER });
  expect(queryButton(strings.placementPlaceOnLastPage)).toBeNull();
});

const WORKSPACE_ID = "b0123344-5566-7788-9900-aabbccddeeff";
const ENTITY_ID = "c0123344-5566-7788-9900-aabbccddeeff";
const PROPERTY_ID = "d0123344-5566-7788-9900-aabbccddeeff";

const signTarget = {
  entityId: ENTITY_ID,
  fieldId: FIELD_ID,
  propertyId: PROPERTY_ID,
  workspaceId: WORKSPACE_ID,
} satisfies PdfSignTarget;

const contract = {
  entityId: toSafeId<"entity">(ENTITY_ID),
  kind: "document",
  name: "Share purchase agreement",
  parentId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: null,
  createdByUserId: null,
  createdByImage: null,
  createdByDeletedAt: null,
  updatedAt: null,
  version: 1,
  currentVersionReference: null,
  status: null,
  priority: null,
  listItemType: null,
  dueDate: null,
  agendaKind: "task",
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
  cellMetadata: {},
  assignees: [],
  fields: {
    [toSafeId<"property">(PROPERTY_ID)]: {
      id: toSafeId<"field">(FIELD_ID),
      propertyId: toSafeId<"property">(PROPERTY_ID),
      entityId: toSafeId<"entity">(ENTITY_ID),
      content: {
        type: "file",
        version: 1,
        id: "e0123344-5566-7788-9900-aabbccddeeff",
        fileName: "share-purchase-agreement.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        encrypted: false,
        sha256Hex: "a".repeat(64),
        pdfFileId: null,
      },
    },
  },
} satisfies WorkspaceEntity;

/** The list row's sign action, held by the row as the row menu holds it. */
const ListRow = () => {
  const { flow, sign } = usePdfSignFromList({
    entity: contract,
    target: signTarget,
    workspaceId: WORKSPACE_ID,
  });
  return (
    <button data-row-sign="" onClick={sign} type="button">
      {flow.actionLabel}
    </button>
  );
};

/** The inspector beside the list: the active file tab's preview, placing. */
const InspectorPreview = () => {
  const activeTab = useInspectorTabsStore((state) =>
    state.tabs.find((tab) => tab.id === state.activeId),
  );
  const previewedFieldId =
    activeTab?.type === "pdf" && activeTab.facet === "preview"
      ? activeTab.id
      : null;
  const isPlacing = usePdfSignPlacementStore(
    (state) =>
      previewedFieldId !== null && state.session?.fieldId === previewedFieldId,
  );
  if (!isPlacing) {
    return null;
  }
  return (
    <>
      <PdfSignPlacementControls showsOwnPages />
      <PdfSignPlacementPage page={A4} pageIndex={0} />
    </>
  );
};

const rowSign = () =>
  document.querySelector<HTMLElement>("[data-row-sign]") ??
  panic("The row's sign action is missing");

test("signing from a list row places the stamp in the inspector and the row reads as signing until the exchange settles", async () => {
  const handoff = Promise.withResolvers<Response>();
  const handoffRequests: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("pdf-signing-handoffs")) {
          handoffRequests.push(url);
          return await handoff.promise;
        }
        return Response.json(null);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Providers = ({ children }: { children: ReactNode }) => (
    <IntlProvider locale="en" messages={en} timeZone="UTC">
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </IntlProvider>
  );
  render(
    <Providers>
      <ListRow />
      <InspectorPreview />
    </Providers>,
  );
  expect(rowSign().textContent).toBe(strings.placementTitle);

  fireEvent.click(rowSign());

  // The file opens in the inspector, on its preview, in placement.
  const inspector = useInspectorTabsStore.getState();
  const tab = inspector.tabs.find((candidate) => candidate.id === FIELD_ID);
  expect(inspector.activeId).toBe(FIELD_ID);
  expect(tab?.type === "pdf" ? tab.facet : null).toBe("preview");
  expect(usePdfSignPlacementStore.getState().session?.fieldId).toBe(FIELD_ID);
  expect(button(strings.placementSignInvisible)).toBeDefined();

  fireEvent.click(button(strings.placementSignInvisible));

  // The row that started it holds the exchange for its whole length.
  await waitFor(() => expect(handoffRequests).toHaveLength(1));
  expect(rowSign().textContent).toBe(strings.signingLabel);
  expect(queryButton(strings.placementSignInvisible)).toBeNull();

  await act(async () => {
    handoff.resolve(
      Response.json(
        {
          code: "pdf_signing_not_a_pdf",
          message: "Only PDF files can be signed.",
        },
        { status: 422 },
      ),
    );
  });
  await waitFor(() =>
    expect(rowSign().textContent).toBe(strings.placementTitle),
  );
  client.clear();
});
