import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });

const originalFetch = globalThis.fetch;
// Auth client imports start the boot prefetch; nothing here may reach a server.
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});

const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { roleOptions } = await import("@/lib/auth-queries");
const { SidebarEntityRow } = await import("@/components/sidebar-entity-row");

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const NAME = "Smlouva o dílo";

const menuLabels = () =>
  Array.from(document.querySelectorAll('[role="menuitem"]'), (item) =>
    item.textContent.trim(),
  );

const rightClick = (element: Element, init: MouseEventInit = {}) => {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    button: 2,
    cancelable: true,
    clientX: 10,
    clientY: 10,
    ...init,
  });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
};

const mountRow = (task: { entityId: string; status: "open" } | null = null) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // An owner may rename and delete, so the row offers its full list.
  queryClient.setQueryData(roleOptions.queryKey, "owner");
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <ul>
          <SidebarEntityRow
            entityId={task?.entityId ?? "entity-1"}
            entityKind={task === null ? "document" : "task"}
            name={NAME}
            onDelete={() => undefined}
            onOpen={() => undefined}
            taskStatus={task?.status ?? null}
            workspaceId="workspace-1"
          >
            {NAME}
          </SidebarEntityRow>
        </ul>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

describe("SidebarEntityRow right-click", () => {
  test("opens the row's own actions", async () => {
    const view = mountRow();
    const event = rightClick(view.getByRole("button", { name: NAME }));
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(menuLabels()).toEqual([
        messages.common.rename,
        messages.workspaces.deleteFromMatter,
      ]);
    });
  });

  test("Shift + right-click keeps the native menu", async () => {
    const view = mountRow();
    const event = rightClick(view.getByRole("button", { name: NAME }), {
      shiftKey: true,
    });
    expect(event.defaultPrevented).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(menuLabels()).toEqual([]);
  });

  test("Rename from the menu edits in place, where the native menu stays", async () => {
    const view = mountRow();
    rightClick(view.getByRole("button", { name: NAME }));
    await waitFor(() => {
      expect(menuLabels()).toContain(messages.common.rename);
    });
    const rename = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((item) => item.textContent.trim() === messages.common.rename);
    if (!(rename instanceof HTMLElement)) {
      throw new TypeError("The rename item is missing.");
    }
    act(() => {
      rename.click();
    });
    const input = await waitFor(() => view.getByRole("textbox"));
    expect(rightClick(input).defaultPrevented).toBe(false);
  });
});

describe("SidebarEntityRow task status", () => {
  test("a task's menu changes its status; a document's has no status", async () => {
    const patches: { pathname: string; body: unknown }[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method === "PATCH") {
          patches.push({
            pathname: new URL(request.url).pathname,
            body: await request.json(),
          });
        }
        return Response.json({});
      },
      { preconnect: () => undefined },
    );

    const document = mountRow();
    rightClick(document.getByRole("button", { name: NAME }));
    await waitFor(() => {
      expect(menuLabels()).toContain(messages.common.rename);
    });
    expect(menuLabels()).not.toContain(messages.common.status);
    cleanup();

    const task = mountRow({ entityId: "task-1", status: "open" });
    rightClick(task.getByRole("button", { name: NAME }));
    const status = await waitFor(() => {
      const item = Array.from(
        window.document.querySelectorAll('[role="menuitem"]'),
      ).find(
        (element) => element.textContent.trim() === messages.common.status,
      );
      if (!(item instanceof HTMLElement)) {
        throw new TypeError("The status item is missing.");
      }
      return item;
    });
    // The submenu opens from the keyboard as it does on hover.
    act(() => {
      status.focus();
    });
    fireEvent.keyDown(status, { key: "ArrowRight" });

    // A checked option also reads its state ("Selected") before its label.
    const option = (label: string) =>
      Array.from(
        window.document.querySelectorAll('[role="menuitemcheckbox"]'),
      ).find((element) => element.textContent.trim().endsWith(label));
    await waitFor(() => {
      expect(
        option(messages.tasks.statusValues.open)?.getAttribute("aria-checked"),
      ).toBe("true");
    });
    const inProgress = option(messages.tasks.statusValues.in_progress);
    if (!(inProgress instanceof HTMLElement)) {
      throw new TypeError("The in-progress option is missing.");
    }
    fireEvent.click(inProgress);
    await waitFor(() => {
      expect(patches).toEqual([
        {
          pathname: "/v1/tasks/workspace-1",
          body: { status: "in_progress", taskId: "task-1" },
        },
      ]);
    });
  });
});
