import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });

const originalFetch = globalThis.fetch;
// Auth client imports start the boot prefetch; nothing here may reach a server.
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});

const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, render, waitFor } =
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

const mountRow = () => {
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
            activeOrganizationId="org-1"
            entityId="entity-1"
            entityKind="document"
            name={NAME}
            onDelete={() => undefined}
            onOpen={() => undefined}
            userId="user-1"
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
        messages.common.delete,
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
      throw new Error("The rename item is missing.");
    }
    act(() => {
      rename.click();
    });
    const input = await waitFor(() => view.getByRole("textbox"));
    expect(rightClick(input).defaultPrevented).toBe(false);
  });
});
