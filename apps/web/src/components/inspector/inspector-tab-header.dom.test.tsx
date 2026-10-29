import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import type { FileTab } from "@/components/inspector/inspector-store-types";
import englishMessages from "@/i18n/langs/en.json";
import { AVAILABLE_EVERYWHERE } from "@/lib/platform/requirements.logic";
import { unregisterDomEnvironment } from "@/test-dom-environment";

const NativeBroadcastChannel = globalThis.BroadcastChannel;
GlobalRegistrator.register({ url: "http://localhost:3000" });
window.BroadcastChannel = NativeBroadcastChannel;
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { InspectorTabHeader } = await import("./inspector-tab-header");
const { fileTabHeaderActions, getFileTabHeaderProps } =
  await import("./file-tab-header");
const { useFileTabRename } = await import("./use-file-tab-rename");
const { useInspectorTabsStore } = await import("./inspector-tabs-store");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");

const STORED_NAME = "Engagement letter.docx";
const BASE_NAME = "Engagement letter";

const renamedTo: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const requestBody = init?.body;
    if (!url.includes("/rename") || typeof requestBody !== "string") {
      throw new Error(`Unexpected transport: ${url}`);
    }
    const { name } = JSON.parse(requestBody);
    renamedTo.push(name);
    return Response.json({
      entityId: "letter",
      name,
      file: { fieldId: "field-letter", fileName: name },
    });
  },
  { preconnect: originalFetch.preconnect },
);

const letter: FileTab = {
  type: "pdf",
  id: "field-letter",
  entityId: "letter",
  workspaceId: "matter",
  label: STORED_NAME,
  fileName: STORED_NAME,
  pdfFileId: null,
};

const FileHeader = () => {
  const tabs = useInspectorTabsStore((s) => s.tabs);
  const rename = useFileTabRename({ tabs });
  const tab =
    tabs.find(
      (candidate): candidate is FileTab =>
        candidate.type === "pdf" && candidate.id === letter.id,
    ) ?? panic("The renamed tab must stay open");
  return (
    <InspectorTabHeader
      {...getFileTabHeaderProps({
        ...rename,
        handleCloseTab: () => undefined,
        matterOrigin: null,
        ribbonLabelContextMenuOpenAt: () => undefined,
        tab,
      })}
      actions={[
        {
          id: "download",
          requires: AVAILABLE_EVERYWHERE,
          render: () => (
            <button
              aria-label={englishMessages.common.download}
              type="button"
            />
          ),
        },
      ]}
    />
  );
};

const mount = () => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: "org",
            id: "user",
            email: "rename@example.test",
            image: null,
            name: "Rename tester",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <FileHeader />
        </AuthenticatedUserProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return client;
};

const startRename = () => {
  fireEvent.doubleClick(screen.getByText(BASE_NAME));
  const field = screen.getByRole("textbox", {
    name: englishMessages.common.rename,
  });
  if (!(field instanceof HTMLInputElement)) {
    return panic("The rename field must be a text input");
  }
  return field;
};

const headerActions = () => [
  screen.queryByRole("button", { name: englishMessages.common.download }),
  screen.queryByRole("button", { name: englishMessages.common.close }),
];

beforeEach(() => {
  useInspectorTabsStore.getState().openFile(letter);
});

afterEach(async () => {
  await act(async () => cleanup());
  renamedTo.length = 0;
  useInspectorTabsStore.setState({ tabs: [], activeId: null });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

describe("renaming a file from the inspector header", () => {
  test("gives the base name the whole row and keeps the extension fixed", () => {
    mount();
    expect(headerActions().every((action) => action !== null)).toBe(true);

    const field = startRename();

    expect(field.value).toBe(BASE_NAME);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(BASE_NAME.length);
    expect(screen.queryByText(".docx")).not.toBeNull();
    // Only the mobile back button stays: no actions, close or Done button.
    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([englishMessages.common.back]);
  });

  test("Enter commits the base name with the extension re-attached", async () => {
    const client = mount();
    const field = startRename();

    fireEvent.change(field, { target: { value: "Retainer" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(renamedTo).toEqual(["Retainer.docx"]);
    expect(screen.queryByText("Retainer")).not.toBeNull();
    expect(headerActions().every((action) => action !== null)).toBe(true);
  });

  test("leaving the field commits the draft", async () => {
    const client = mount();
    const field = startRename();

    fireEvent.change(field, { target: { value: "Retainer" } });
    act(() => field.blur());

    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(renamedTo).toEqual(["Retainer.docx"]);
  });

  test("Escape discards the draft and restores the header", async () => {
    const client = mount();
    const field = startRename();

    fireEvent.change(field, { target: { value: "Retainer" } });
    fireEvent.keyDown(field, { key: "Escape" });

    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(renamedTo).toEqual([]);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(BASE_NAME)).not.toBeNull();
    expect(headerActions().every((action) => action !== null)).toBe(true);
  });

  test("a blank name closes the editor without renaming", async () => {
    const client = mount();
    const field = startRename();

    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(renamedTo).toEqual([]);
    expect(screen.queryByText(BASE_NAME)).not.toBeNull();
  });
});

test("legal tab headers preserve an identity while clamping only the subject", async () => {
  const { StatuteDisplayLabel } =
    await import("@/features/statutes/components/statute-display-label");
  render(
    <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
      <InspectorTabHeader
        label="Zákon č. 274/2026 Z. z."
        labelOverflow="wrap"
        labelContent={
          <StatuteDisplayLabel
            statute={{
              country: "SVK",
              documentType: "zákon",
              eli: "/eli/sk/zz/2026/274",
              title: `ktorým sa mení ${"zákon o stavebnom sporení ".repeat(40)}`,
            }}
          />
        }
        onClose={() => undefined}
      />
    </IntlProvider>,
  );
  const identity = screen.getByText("Zákon č. 274/2026 Z. z.");
  for (
    let element: HTMLElement | null = identity;
    element !== null;
    element = element.parentElement
  ) {
    expect(element.className).not.toMatch(
      /overflow-hidden|text-ellipsis|line-clamp/u,
    );
  }
  expect(
    screen.getByRole("button", { name: englishMessages.common.close }),
  ).toBeDefined();
});

describe("file actions in the inspector header", () => {
  const actionIds = (mainViewHasFileActions: boolean) =>
    fileTabHeaderActions({
      desktopEditTarget: { fileType: "docx", propertyId: "file" },
      downloadRenditions: [],
      mainViewHasFileActions,
      pdfSignTarget: {
        entityId: letter.entityId,
        fieldId: letter.id,
        propertyId: "file",
        workspaceId: letter.workspaceId,
      },
      tab: letter,
    }).map((action) => action.id);

  test("the peek header offers download, desktop open and sign", () => {
    expect(actionIds(false)).toEqual([
      "download",
      "open-in-desktop-app",
      "sign",
    ]);
  });

  test("leaves download and sign to a main view that already shows them", () => {
    expect(actionIds(true)).toEqual(["open-in-desktop-app"]);
  });
});
