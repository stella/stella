import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

let handoffCalls = 0;

const { act, cleanup, fireEvent, renderHook, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { stellaToast, ToastProvider } = await import("@stll/ui/toast");
const { usePdfSignFlow } = await import("./pdf-sign-action");
const {
  confirmPdfSignPlacement,
  endPdfSignPlacement,
  usePdfSignPlacementStore,
} = await import("./pdf-sign-placement-store");
const { createPageOrganizerOperationOwner } =
  await import("@/components/pdf/page-organizer-upload.logic");
const en = (await import("@/i18n/langs/en.json")).default;

const workspaceId = "90123344-5566-7788-9900-aabbccddeeff";
const entityId = "a0123344-5566-7788-9900-aabbccddeeff";
const oldFieldId = "b0123344-5566-7788-9900-aabbccddeeff";
const savedFieldId = "c0123344-5566-7788-9900-aabbccddeeff";
const otherFieldId = "d0123344-5566-7788-9900-aabbccddeeff";
const target = (fieldId: string) => ({
  entityId,
  fieldId,
  propertyId: workspaceId,
  workspaceId,
});
const identity = (fieldId: string) => ({ entityId, fieldId, workspaceId });

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

const stubSigningApi = ({
  handoff,
  expired = false,
}: {
  handoff?: Promise<Response>;
  expired?: boolean;
} = {}) => {
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("pdf-signing-handoffs")) {
          handoffCalls += 1;
          return (
            (await handoff) ??
            json({
              deepLinkUrl: "http://localhost:3000/pdf-signing-owner-test",
              expiresAt: new Date(
                Date.now() + (expired ? -1 : 60_000),
              ).toISOString(),
              sessionId: workspaceId,
            })
          );
        }
        if (url.includes("pdf-signing-sessions")) {
          return json({
            closeReason: null,
            expiresAt: new Date(Date.now() - 1).toISOString(),
            finalizedVersionNumber: null,
            status: expired ? "expired" : "open",
          });
        }
        return json({});
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
};

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <IntlProvider locale="en" messages={en}>
      <ToastProvider>{children}</ToastProvider>
    </IntlProvider>
  </QueryClientProvider>
);

const mountOwner = () => {
  const owner = createPageOrganizerOperationOwner();
  const hook = renderHook(({ fieldId }) => usePdfSignFlow(identity(fieldId)), {
    initialProps: { fieldId: oldFieldId },
    wrapper,
  });
  const transfer = (fieldId: string, allowSavedField = false) => {
    const request = owner.beginRequest(owner.operation);
    return hook.result.current.transferToSigning(
      request,
      target(fieldId),
      undefined,
      allowSavedField,
    );
  };
  return { hook, owner, transfer };
};

afterEach(async () => {
  await act(async () => {
    stellaToast.close();
  });
  cleanup();
  endPdfSignPlacement();
  handoffCalls = 0;
  mock.restore();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

test("dirty save-and-sign carries placement across its saved-field remount", () => {
  const { hook, transfer } = mountOwner();
  expect(transfer(savedFieldId, true)).toBe(true);
  hook.rerender({ fieldId: savedFieldId });
  expect(usePdfSignPlacementStore.getState().session?.fieldId).toBe(
    savedFieldId,
  );

  stubSigningApi();
  act(() => confirmPdfSignPlacement(undefined));
  expect(usePdfSignPlacementStore.getState().session).toBeNull();
});

test("organizer teardown after transfer does not cancel the parent session", () => {
  const { hook, owner, transfer } = mountOwner();
  transfer(savedFieldId, true);
  owner.revoke();
  hook.rerender({ fieldId: savedFieldId });

  expect(usePdfSignPlacementStore.getState().session?.fieldId).toBe(
    savedFieldId,
  );
});

test("revoking the organizer before transfer leaves no session or placement", () => {
  const { owner, transfer } = mountOwner();
  owner.revoke();

  expect(transfer(savedFieldId, true)).toBe(false);
  expect(usePdfSignPlacementStore.getState().session).toBeNull();
});

test("selecting another version while a handoff is held prevents its deep link", async () => {
  const held = Promise.withResolvers<Response>();
  stubSigningApi({ handoff: held.promise });
  const initialHref = window.location.href;
  const { hook, transfer } = mountOwner();
  transfer(oldFieldId);
  act(() => confirmPdfSignPlacement(undefined));
  await waitFor(() => expect(handoffCalls).toBe(1));
  hook.rerender({ fieldId: otherFieldId });

  held.resolve(
    json({
      deepLinkUrl: "http://localhost:3000/pdf-signing-owner-test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sessionId: workspaceId,
    }),
  );
  await act(async () => await held.promise);
  expect(window.location.href).toBe(initialHref);
});

test("selecting another version invalidates an expired attempt's retained Retry", async () => {
  stubSigningApi({ expired: true });
  const { hook, transfer } = mountOwner();
  transfer(oldFieldId);
  act(() => confirmPdfSignPlacement(undefined));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: en.common.retry }),
    ).not.toBeNull(),
  );
  hook.rerender({ fieldId: otherFieldId });

  fireEvent.click(screen.getByRole("button", { name: en.common.retry }));
  await Promise.resolve();
  expect(handoffCalls).toBe(1);
});

test("a document change after placement and before confirmation starts no handoff", () => {
  const { hook, transfer } = mountOwner();
  transfer(oldFieldId);
  hook.rerender({ fieldId: otherFieldId });

  act(() => confirmPdfSignPlacement(undefined));
  expect(handoffCalls).toBe(0);
  expect(usePdfSignPlacementStore.getState().session).toBeNull();
});
