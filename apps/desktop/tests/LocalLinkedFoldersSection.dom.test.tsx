import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { LinkedFolderStatus } from "../src/mainview/local-linked-folders-status";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { LocalLinkedFoldersSection } =
  await import("../src/mainview/LocalLinkedFoldersSection");

/** One macrotask, for the mocked IPC promises and React's scheduler. */
const nextMacrotask = async () =>
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

afterEach(async () => {
  await act(nextMacrotask);
  cleanup();
  clearMocks();
});

afterAll(async () => {
  await nextMacrotask();
  await GlobalRegistrator.unregister();
});

/** Tauri rejects `invoke` with the command's error string. */
const refuse = (code: string): never => {
  // oxlint-disable-next-line typescript/only-throw-error -- Tauri's rejection value is this string, and the section reads it.
  throw code;
};

const messages = defaultMessages.localLinkedFolders;

const linked: LinkedFolderStatus = {
  id: "0192f3a0-6b1c-7d2e-8f30-0000000000d1",
  name: "Smith v Jones",
  path: "/cases/Smith v Jones",
  state: "available",
};

type Native = {
  list: () => unknown;
  /** What the picker command answers; a thrown string is its error code. */
  pick?: () => unknown;
};

const renderSection = ({ list, pick = () => false }: Native) => {
  const calls: { command: string; args: unknown }[] = [];
  mockIPC(
    (command, args) => {
      calls.push({ command, args });
      switch (command) {
        case "local_linked_folders_get":
          return list();
        case "local_linked_folders_pick":
          return pick();
        case "local_linked_folders_remove":
          return null;
        default:
          throw new Error(`unexpected command ${command}`);
      }
    },
    { shouldMockEvents: true },
  );
  const view = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <LocalLinkedFoldersSection
        renderGroup={(content) => <section>{content}</section>}
      />
    </DesktopIntlProvider>,
  );
  return { ...view, calls };
};

test("renders nothing, group included, when the feature refuses the read", async () => {
  const { container, calls } = renderSection({
    list: () => refuse("feature_disabled"),
  });
  await waitFor(() => {
    expect(
      calls.some(({ command }) => command === "local_linked_folders_get"),
    ).toBe(true);
  });
  expect(container.querySelector("section")).toBeNull();
});

test("shows a folder by its name and path and unlinks it by its id", async () => {
  const { calls, findByText, getByRole } = renderSection({
    list: () => [linked],
  });
  await findByText(linked.name);
  await findByText(linked.path);

  fireEvent.click(
    getByRole("button", {
      name: messages.removeFolder.replace("{name}", () => linked.name),
    }),
  );

  await waitFor(() => {
    expect(calls).toContainEqual({
      command: "local_linked_folders_remove",
      args: { id: linked.id },
    });
  });
});

test("a folder that is offline or moved says so", async () => {
  const { findByText } = renderSection({
    list: () =>
      [
        { ...linked, state: "offline" },
        {
          ...linked,
          id: "0192f3a0-6b1c-7d2e-8f30-0000000000d2",
          state: "moved",
        },
      ] satisfies LinkedFolderStatus[],
  });
  await findByText(messages.state.offline);
  await findByText(messages.state.moved);
});

test("a refused link names the reason", async () => {
  const { findByRole } = renderSection({
    list: () => [],
    pick: () => refuse("protected"),
  });

  fireEvent.click(await findByRole("button", { name: messages.add }));

  expect((await findByRole("alert")).textContent).toBe(
    messages.notice.protected,
  );
});
