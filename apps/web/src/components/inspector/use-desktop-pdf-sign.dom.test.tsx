import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { Temporal } from "@stll/time";

GlobalRegistrator.register();
const fetchBoundary = spyOn(globalThis, "fetch");
const { act, cleanup, fireEvent, renderHook, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { stellaToast, ToastProvider } = await import("@stll/ui/toast");
const { useDesktopPdfSign } =
  await import("@/components/inspector/use-desktop-pdf-sign");
const en = (await import("@/i18n/langs/en.json")).default;

const copy = en.workspaces.files.pdfSigning;
const ID = "90123344-5566-7788-9900-aabbccddeeff";
const target = { entityId: ID, propertyId: ID, workspaceId: ID };

afterEach(async () => {
  await act(async () => {
    stellaToast.close();
  });
  cleanup();
  fetchBoundary.mockReset();
});
afterAll(async () => {
  fetchBoundary.mockRestore();
  await GlobalRegistrator.unregister();
});

type SessionPayload = {
  closeReason: string | null;
  expiresAt: string;
  finalizedVersionNumber: number | null;
  status: string;
};

type ApiStub = {
  /** Resolves the handoff create; defaults to an immediate response. */
  handoff?: Promise<undefined> | undefined;
  readSession: () => SessionPayload;
  cancelSession?: (() => SessionPayload) | undefined;
};

const json = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });

const stubApi = ({ handoff, readSession, cancelSession }: ApiStub) => {
  const calls = { cancel: 0, handoff: 0, read: 0 };
  const expiresAt = Temporal.Now.instant().add({ minutes: 2 }).toString();
  fetchBoundary.mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("pdf-signing-handoffs")) {
          calls.handoff += 1;
          await handoff;
          return json({
            deepLinkUrl: "stella://pdf-signing",
            expiresAt,
            sessionId: ID,
          });
        }
        if (url.endsWith("/cancel") && cancelSession !== undefined) {
          calls.cancel += 1;
          return json(cancelSession());
        }
        if (url.includes("pdf-signing-sessions")) {
          calls.read += 1;
          return json(readSession());
        }
        return json({});
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  return { calls, expiresAt };
};

const mountSign = () => {
  const connects: string[] = [];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = renderHook(
    () =>
      useDesktopPdfSign({
        connectDesktop: () => {
          connects.push("connect");
        },
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <IntlProvider locale="en" messages={en}>
          <QueryClientProvider client={client}>
            <ToastProvider>{children}</ToastProvider>
          </QueryClientProvider>
        </IntlProvider>
      ),
    },
  );
  return { client, connects, ui };
};

test("the waiting toast appears before the handoff is minted, and a second press says signing is running", async () => {
  const handoff = Promise.withResolvers<undefined>();
  const { calls, expiresAt } = stubApi({
    handoff: handoff.promise,
    readSession: () => ({
      closeReason: null,
      expiresAt,
      finalizedVersionNumber: 3,
      status: "finalized",
    }),
  });
  const { client, ui } = mountSign();

  let first: Promise<void> | undefined;
  await act(async () => {
    first = ui.result.current.sign({ target });
  });
  await waitFor(() =>
    expect(document.body.textContent).toContain(copy.preparingDescription),
  );
  expect(document.body.textContent).toContain(copy.waitingTitle);
  expect(ui.result.current.isSigning).toBe(true);

  await act(async () => {
    await ui.result.current.sign({ target });
  });
  expect(document.body.textContent).toContain(copy.alreadySigningTitle);
  expect(calls.handoff).toBe(1);

  await act(async () => {
    handoff.resolve(undefined);
    await first;
  });
  expect(ui.result.current.isSigning).toBe(false);
  expect(document.body.textContent).toContain(copy.signedTitle);
  client.clear();
});

test("a handoff the desktop app never picked up says it may not be connected and offers connect and retry", async () => {
  const { calls, expiresAt } = stubApi({
    readSession: () => ({
      closeReason: null,
      expiresAt,
      finalizedVersionNumber: null,
      status: "expired",
    }),
  });
  const { client, connects, ui } = mountSign();

  await act(async () => {
    await ui.result.current.sign({ target });
  });
  expect(document.body.textContent).toContain(copy.notPickedUpTitle);
  expect(document.body.textContent).toContain(copy.notPickedUpDescription);
  expect(document.body.textContent).not.toContain(copy.expiredDescription);

  fireEvent.click(
    screen.getByRole("button", {
      name: en.workspaces.files.desktopGate.connect,
    }),
  );
  expect(connects).toEqual(["connect"]);

  fireEvent.click(screen.getByRole("button", { name: en.common.retry }));
  await waitFor(() => expect(calls.handoff).toBe(2));
  await waitFor(() => expect(ui.result.current.isSigning).toBe(false));
  client.clear();
});

test("the waiting toast cancels the session from the browser and offers to connect", async () => {
  let cancelled = false;
  const { calls, expiresAt } = stubApi({
    readSession: () => ({
      closeReason: cancelled ? "user_cancelled" : null,
      expiresAt,
      finalizedVersionNumber: null,
      status: cancelled ? "cancelled" : "open",
    }),
    cancelSession: () => {
      cancelled = true;
      return {
        closeReason: "user_cancelled",
        expiresAt,
        finalizedVersionNumber: null,
        status: "cancelled",
      };
    },
  });
  const { client, connects, ui } = mountSign();

  let signing: Promise<void> | undefined;
  await act(async () => {
    signing = ui.result.current.sign({ target });
  });
  const connect = await screen.findByRole("button", {
    name: copy.notOpeningConnect,
  });
  fireEvent.click(connect);
  expect(connects).toEqual(["connect"]);

  fireEvent.click(screen.getByRole("button", { name: en.common.cancel }));
  await waitFor(() => expect(calls.cancel).toBe(1));
  await act(async () => {
    await signing;
  });
  expect(document.body.textContent).toContain(copy.cancelledTitle);
  expect(document.body.textContent).not.toContain(
    copy.cancelledUserDescription,
  );
  expect(screen.queryByRole("button", { name: en.common.cancel })).toBeNull();
  expect(ui.result.current.isSigning).toBe(false);
  client.clear();
});

test("a failing status read ends in a visible error and frees the action", async () => {
  stubApi({
    readSession: () => {
      throw new Error("unreadable");
    },
  });
  const { client, ui } = mountSign();

  await act(async () => {
    await ui.result.current.sign({ target });
  });
  expect(document.body.textContent).toContain(copy.statusUnavailableTitle);
  expect(document.body.textContent).not.toContain(copy.waitingTitle);
  expect(ui.result.current.isSigning).toBe(false);
  client.clear();
});

test("a browser cancel that loses to a desktop rejection keeps its reason", async () => {
  const rejected = {
    closeReason: "certificate_rejected",
    expiresAt: "",
    finalizedVersionNumber: null,
    status: "cancelled",
  } as const;
  let settled = false;
  const { calls, expiresAt } = stubApi({
    readSession: () =>
      settled
        ? { ...rejected, expiresAt }
        : {
            closeReason: null,
            expiresAt,
            finalizedVersionNumber: null,
            status: "open",
          },
    cancelSession: () => {
      settled = true;
      return { ...rejected, expiresAt };
    },
  });
  const { client, ui } = mountSign();

  let signing: Promise<void> | undefined;
  await act(async () => {
    signing = ui.result.current.sign({ target });
  });
  fireEvent.click(
    await screen.findByRole("button", { name: en.common.cancel }),
  );
  await waitFor(() => expect(calls.cancel).toBe(1));
  await act(async () => {
    await signing;
  });
  expect(document.body.textContent).toContain(
    copy.cancelledCertificateDescription,
  );
  expect(ui.result.current.isSigning).toBe(false);
  client.clear();
});
