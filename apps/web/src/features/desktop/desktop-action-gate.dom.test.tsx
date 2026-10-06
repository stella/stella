import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { desktopPresenceSchema } from "@stll/api-contract/desktop-presence";
import type { DesktopPresence } from "@stll/api-contract/desktop-presence";

import messages from "@/i18n/langs/en.json";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";

import type { DesktopAction } from "./desktop-action-gate.logic";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { act } = await import("react");
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider, focusManager } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { DesktopRequiredDialog, useDesktopActionGate } =
  await import("@/features/desktop/desktop-action-gate");
const { desktopPresenceOptions } = await import("./desktop-presence");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");

const originalFetch = globalThis.fetch;
const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(async () => {
  await act(async () => {
    cleanup();
    for (const client of clients) {
      client.clear();
    }
    clients.length = 0;
    globalThis.fetch = originalFetch;
    focusManager.setFocused(undefined);
  });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const gate = messages.workspaces.files.desktopGate;

type MountOptions = Pick<
  ComponentProps<typeof DesktopRequiredDialog>,
  "action" | "required"
>;

const mount = ({ action, required }: MountOptions) => {
  const calls: string[] = [];
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <DesktopRequiredDialog
        action={action}
        onClose={() => {
          calls.push("close");
        }}
        onConnect={() => {
          calls.push("connect");
        }}
        required={required}
      />
    </IntlProvider>,
  );
  return calls;
};

describe("DesktopRequiredDialog", () => {
  test("without the app, says why signing needs it and offers the download", async () => {
    mount({ action: "sign-pdf", required: "none" });

    expect(await screen.findByText(gate.signNone)).toBeDefined();
    expect(screen.getByText(gate.signReason)).toBeDefined();
    expect(screen.getAllByRole("link").length).toBeGreaterThan(0);
  });

  test("an app that is installed but not linked can be connected instead", async () => {
    const calls = mount({ action: "sign-pdf", required: "none" });

    fireEvent.click(
      await screen.findByRole("button", { name: gate.alreadyInstalled }),
    );
    expect(calls).toEqual(["connect"]);
  });

  test("an outdated app is asked to update, with no connect offer", async () => {
    mount({ action: "edit-file", required: "outdated" });

    expect(await screen.findByText(gate.editOutdated)).toBeDefined();
    expect(screen.getByText(gate.editReason)).toBeDefined();
    expect(
      screen.queryByRole("button", { name: gate.alreadyInstalled }),
    ).toBeNull();
  });

  test("renders nothing while no requirement is pending", () => {
    mount({ action: "sign-pdf", required: null });

    expect(screen.queryByText(gate.signNone)).toBeNull();
  });
});

const user = {
  id: "presence-test-user",
  activeOrganizationId: "presence-test-organization",
  email: "presence@example.test",
  name: "Presence test",
  image: null,
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
} satisfies AuthenticatedUser;

const desktop = {
  version: "1.0.0",
  protocol: 2,
  lastSeenAt: "2026-10-06T07:00:00.000Z",
};
const PRESENCE_FIXTURES = {
  current: { type: "current", desktop },
  outdated: { type: "outdated", desktop },
  not_connected: { type: "not_connected", desktop },
  none: { type: "none" },
} as const satisfies {
  [Type in DesktopPresence["type"]]: Extract<DesktopPresence, { type: Type }>;
};

const EXPECTED_ACTION_LABELS = {
  current: {
    "edit-file": messages.workspaces.files.desktopEdit.openAction,
    "sign-pdf": gate.signCurrent,
  },
  outdated: { "edit-file": gate.editOutdated, "sign-pdf": gate.signOutdated },
  not_connected: { "edit-file": gate.connect, "sign-pdf": gate.connect },
  none: { "edit-file": gate.editNone, "sign-pdf": gate.signNone },
} as const satisfies Record<
  DesktopPresence["type"],
  Record<DesktopAction, string>
>;

type GateHarnessProps = {
  action: DesktopAction;
  onPerform: () => void;
  onCapture: (run: ReturnType<typeof useDesktopActionGate>["run"]) => void;
};
const GateHarness = ({ action, onPerform, onCapture }: GateHarnessProps) => {
  const desktopGate = useDesktopActionGate(action);
  return (
    <>
      <button
        disabled={desktopGate.isConnecting}
        onClick={() => desktopGate.run(onPerform)}
        type="button"
      >
        {desktopGate.label}
      </button>
      <button onClick={() => onCapture(desktopGate.run)} type="button">
        {messages.common.copy}
      </button>
      <DesktopRequiredDialog {...desktopGate.requiredDialog} />
    </>
  );
};

type MountGateOptions = {
  action: DesktopAction;
  presence?: DesktopPresence | undefined;
  authenticated?: boolean | undefined;
};
const mountGate = ({
  action,
  presence,
  authenticated = true,
}: MountGateOptions) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, refetchOnMount: false },
    },
  });
  clients.push(client);
  const options = desktopPresenceOptions({
    userId: user.id,
    organizationId: user.activeOrganizationId,
  });
  if (presence !== undefined) {
    client.setQueryData(options.queryKey, presence);
  }
  const performed: string[] = [];
  const retained: ReturnType<typeof useDesktopActionGate>["run"][] = [];
  const content = (
    <GateHarness
      action={action}
      onPerform={() => {
        performed.push(action);
      }}
      onCapture={(run) => {
        retained.push(run);
      }}
    />
  );
  const view = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        {authenticated ? (
          <AuthenticatedUserProvider user={user}>
            {content}
          </AuthenticatedUserProvider>
        ) : (
          content
        )}
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { client, options, performed, retained, view };
};

describe("desktop action gate uses observed presence", () => {
  test.each(
    desktopPresenceSchema.options.map(({ entries }) => entries.type.literal),
  )(
    "%s presents both desktop actions and preserves their availability",
    async (presence) => {
      for (const action of Object.keys(EXPECTED_ACTION_LABELS[presence])) {
        if (action !== "edit-file" && action !== "sign-pdf") {
          panic(`Unexpected test action: ${action}`);
        }
        const { view, performed } = mountGate({
          action,
          presence: PRESENCE_FIXTURES[presence],
        });
        const trigger = view.getByRole("button", {
          name: EXPECTED_ACTION_LABELS[presence][action],
        });
        expect(trigger.hasAttribute("disabled")).toBe(false);
        if (presence === "current") {
          fireEvent.click(trigger);
          expect(performed).toEqual([action]);
          expect(screen.queryByRole("dialog")).toBeNull();
        }
        if (presence === "none" || presence === "outdated") {
          fireEvent.click(trigger);
          expect(await screen.findByRole("dialog")).toBeDefined();
          expect(performed).toEqual([]);
          expect(
            screen.getByText(
              action === "sign-pdf" ? gate.signReason : gate.editReason,
            ),
          ).toBeDefined();
          expect(screen.getAllByRole("link").length).toBeGreaterThan(0);
        }
        view.unmount();
      }
    },
  );

  test("a pending observation keeps the signing action enabled and opens its workflow", async () => {
    const response = Promise.withResolvers<Response>();
    globalThis.fetch = Object.assign(async () => await response.promise, {
      preconnect: originalFetch.preconnect,
    });
    const { client, options, performed, view } = mountGate({
      action: "sign-pdf",
    });
    await waitFor(() =>
      expect(client.getQueryState(options.queryKey)?.fetchStatus).toBe(
        "fetching",
      ),
    );
    const trigger = view.getByRole("button", { name: gate.signCurrent });
    expect(trigger.hasAttribute("disabled")).toBe(false);
    fireEvent.click(trigger);
    expect(performed).toEqual(["sign-pdf"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    response.resolve(Response.json(PRESENCE_FIXTURES.current));
    await waitFor(() =>
      expect(client.getQueryState(options.queryKey)?.status).toBe("success"),
    );
  });

  test("a failed observation keeps the desktop open action enabled", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({ message: "Presence unavailable" }, { status: 503 }),
      { preconnect: originalFetch.preconnect },
    );
    const { client, options, performed, view } = mountGate({
      action: "edit-file",
    });
    await waitFor(() =>
      expect(client.getQueryState(options.queryKey)?.status).toBe("error"),
    );
    const trigger = view.getByRole("button", {
      name: messages.workspaces.files.desktopEdit.openAction,
    });
    expect(trigger.hasAttribute("disabled")).toBe(false);
    fireEvent.click(trigger);
    expect(performed).toEqual(["edit-file"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("anonymous surfaces enable the deep link without querying account presence", () => {
    let calls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        calls += 1;
        return Response.json(PRESENCE_FIXTURES.none);
      },
      { preconnect: originalFetch.preconnect },
    );
    const { performed, view } = mountGate({
      action: "edit-file",
      authenticated: false,
    });
    fireEvent.click(
      view.getByRole("button", {
        name: messages.workspaces.files.desktopEdit.openAction,
      }),
    );
    expect(performed).toEqual(["edit-file"]);
    expect(calls).toBe(0);
  });

  test("a refetch error enables the deep link even when cached presence required download", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({ message: "Presence unavailable" }, { status: 503 }),
      { preconnect: originalFetch.preconnect },
    );
    const { client, options, performed, view } = mountGate({
      action: "sign-pdf",
      presence: PRESENCE_FIXTURES.none,
    });
    expect(view.getByRole("button", { name: gate.signNone })).toBeDefined();
    await act(
      async () =>
        await client.invalidateQueries({ queryKey: options.queryKey }),
    );
    await waitFor(() =>
      expect(client.getQueryState(options.queryKey)?.status).toBe("error"),
    );
    const trigger = view.getByRole("button", { name: gate.signCurrent });
    expect(trigger.hasAttribute("disabled")).toBe(false);
    fireEvent.click(trigger);
    expect(performed).toEqual(["sign-pdf"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("returning to a focused window refreshes presence before its cache becomes stale", async () => {
    globalThis.fetch = Object.assign(
      async () => Response.json(PRESENCE_FIXTURES.current),
      { preconnect: originalFetch.preconnect },
    );
    const { client, options, view } = mountGate({
      action: "sign-pdf",
      presence: PRESENCE_FIXTURES.none,
    });
    expect(view.getByRole("button", { name: gate.signNone })).toBeDefined();
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() =>
      expect(client.getQueryData(options.queryKey)?.type).toBe("current"),
    );
    expect(
      view
        .getByRole("button", { name: gate.signCurrent })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  test("a retained desktop action asks for download after the presence becomes absent", async () => {
    const { client, options, retained, view } = mountGate({
      action: "sign-pdf",
      presence: PRESENCE_FIXTURES.current,
    });
    fireEvent.click(view.getByRole("button", { name: messages.common.copy }));
    const run = retained.at(0);
    if (run === undefined) {
      panic("The desktop action was not captured");
    }
    await act(async () => {
      client.setQueryData(options.queryKey, PRESENCE_FIXTURES.none);
    });
    await waitFor(() =>
      expect(view.getByRole("button", { name: gate.signNone })).toBeDefined(),
    );
    const performed: string[] = [];
    await act(async () => {
      run(() => {
        performed.push("sign");
      });
    });
    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.getByText(gate.signReason)).toBeDefined();
    expect(performed).toEqual([]);
  });

  test("a retained desktop action performs after the desktop app becomes current", async () => {
    const { client, options, retained, view } = mountGate({
      action: "edit-file",
      presence: PRESENCE_FIXTURES.none,
    });
    fireEvent.click(view.getByRole("button", { name: messages.common.copy }));
    const run = retained.at(0);
    if (run === undefined) {
      panic("The desktop action was not captured");
    }
    await act(async () => {
      client.setQueryData(options.queryKey, PRESENCE_FIXTURES.current);
    });
    await waitFor(() =>
      expect(
        view.getByRole("button", {
          name: messages.workspaces.files.desktopEdit.openAction,
        }),
      ).toBeDefined(),
    );
    const performed: string[] = [];
    await act(async () => {
      run(() => {
        performed.push("open");
      });
    });
    expect(performed).toEqual(["open"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
