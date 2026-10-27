import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { AcceptedMatterClientDrop } from "@/routes/_protected.workspaces/-components/matter-client-drop.logic";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register();
const { act } = await import("react");
const { cleanup, fireEvent, render, renderHook, waitFor } =
  await import("@testing-library/react");
const { QueryClient } = await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { ToastProvider, stellaToast } = await import("@stll/ui/toast");
const { toAPIError } = await import("@/lib/errors/api");
const { resetUserErrorReportDedupeForTests } =
  await import("@/lib/errors/user-toast");
const messages = (await import("@/i18n/langs/en.json")).default;
const { useMatterClientDropState } = await import("./use-matter-client-drop");

type Mutation = Parameters<typeof useMatterClientDropState>[0];
type Call = {
  variables: Parameters<Mutation["mutate"]>[0];
  callbacks: Parameters<Mutation["mutate"]>[1];
};

const MOVE = {
  type: "move",
  matterId: "matter-lease",
  matterName: "Lease review",
  clientId: "client-next",
  clientName: "Next client",
  previousClientId: "client-previous",
} as const satisfies AcceptedMatterClientDrop;

const wrapper = ({ children }: { children: ReactNode }) => (
  <IntlProvider locale="en" messages={messages}>
    <ToastProvider>{children}</ToastProvider>
  </IntlProvider>
);

const mount = () => {
  const calls: Call[] = [];
  const client = new QueryClient();
  const context = { client, meta: undefined, mutationKey: undefined };
  const { result } = renderHook(
    () =>
      useMatterClientDropState({
        isPending: false,
        mutate: (variables, callbacks) => {
          calls.push({ variables, callbacks });
        },
      }),
    { wrapper },
  );
  const succeed = async (call: Call | undefined) => {
    if (!call) {
      throw new Error("Expected a pending client assignment");
    }
    await act(async () => {
      call.callbacks?.onSuccess?.(
        undefined,
        call.variables,
        undefined,
        context,
      );
    });
  };
  const fail = async (call: Call | undefined) => {
    if (!call) {
      throw new Error("Expected a pending client assignment");
    }
    await act(async () => {
      call.callbacks?.onError?.(
        toAPIError({ status: 500, value: { message: "Private failure" } }),
        call.variables,
        undefined,
        context,
      );
    });
    await waitFor(() => {
      expect(
        [...document.querySelectorAll('[data-slot="toast-title"]')].some(
          (node) => node.textContent === messages.errors.actionFailed,
        ),
      ).toBe(true);
    });
  };
  return { calls, result, succeed, fail };
};

afterEach(async () => {
  await act(async () => {
    stellaToast.dismiss();
  });
  cleanup();
  resetUserErrorReportDedupeForTests();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

test("a moved matter offers Undo and sends its original client", async () => {
  const harness = mount();
  act(() => {
    harness.result.current.onMatterDrop(MOVE);
  });
  expect(harness.calls.map(({ variables }) => variables)).toEqual([
    {
      workspaceId: MOVE.matterId,
      update: { type: "clientId", value: MOVE.clientId },
    },
  ]);
  await harness.succeed(harness.calls.at(0));
  const undo = document.querySelector<HTMLButtonElement>(
    '[data-slot="toast-action"]',
  );
  expect(undo?.textContent).toBe(messages.common.undo);
  if (!undo) {
    throw new Error("Expected an Undo toast action");
  }
  act(() => {
    fireEvent.click(undo);
  });
  expect(harness.calls.at(1)?.variables).toEqual({
    workspaceId: MOVE.matterId,
    update: { type: "clientId", value: MOVE.previousClientId },
  });
  await harness.fail(harness.calls.at(1));
  expect(
    [...document.querySelectorAll('[data-slot="toast-title"]')].some(
      (node) => node.textContent === messages.errors.actionFailed,
    ),
  ).toBe(true);
});

test("a failed forward move shows an error without offering Undo", async () => {
  const harness = mount();
  act(() => {
    harness.result.current.onMatterDrop(MOVE);
  });
  await harness.fail(harness.calls.at(0));
  expect(document.querySelector('[data-slot="toast-action"]')).toBeNull();
  expect(document.querySelector('[data-slot="toast-title"]')?.textContent).toBe(
    messages.errors.actionFailed,
  );
});

test("promoting a personal matter waits for confirmation and offers no Undo", async () => {
  const harness = mount();
  act(() => {
    harness.result.current.onMatterDrop({
      type: "promote",
      matterId: MOVE.matterId,
      matterName: MOVE.matterName,
      clientId: MOVE.clientId,
      clientName: MOVE.clientName,
    });
  });
  expect(harness.calls).toHaveLength(0);
  const dialog = render(harness.result.current.promotionDialog, { wrapper });
  await act(async () => {
    fireEvent.click(
      dialog.getByRole("button", {
        name: messages.workspaces.parties.promoteCta,
      }),
    );
  });
  await harness.succeed(harness.calls.at(0));
  expect(document.querySelector('[data-slot="toast-action"]')).toBeNull();
  expect(
    document.querySelector('[data-slot="toast-title"]')?.textContent,
  ).toContain(MOVE.matterName);
});
