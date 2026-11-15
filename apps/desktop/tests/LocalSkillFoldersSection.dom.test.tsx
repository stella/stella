import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { SkillFolderStatus } from "../src/mainview/local-skill-folders-status";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { LocalSkillFoldersSection } =
  await import("../src/mainview/LocalSkillFoldersSection");

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

const messages = defaultMessages.localSkills;

const usable: SkillFolderStatus = {
  path: "/skills/fixture-skill",
  skillName: "fixture-skill",
  problem: null,
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
        case "local_skill_folders_get":
          return list();
        case "local_skill_folders_pick":
          return pick();
        case "local_skill_folders_remove":
          return null;
        default:
          throw new Error(`unexpected command ${command}`);
      }
    },
    { shouldMockEvents: true },
  );
  const view = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <LocalSkillFoldersSection
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
      calls.some(({ command }) => command === "local_skill_folders_get"),
    ).toBe(true);
  });
  expect(container.querySelector("section")).toBeNull();
});

test("shows a folder's skill and removes the folder by its path", async () => {
  const { calls, findByText, getByRole } = renderSection({
    list: () => [usable],
  });
  await findByText("fixture-skill");
  await findByText(usable.path);

  fireEvent.click(
    getByRole("button", {
      name: messages.removeFolder.replace("{path}", () => usable.path),
    }),
  );

  await waitFor(() => {
    expect(calls).toContainEqual({
      command: "local_skill_folders_remove",
      args: { path: usable.path },
    });
  });
});

test("a folder that no longer qualifies says why and can still be removed", async () => {
  const { findByText, getByRole } = renderSection({
    list: () =>
      [
        { path: "/skills/gone", skillName: null, problem: "missing" },
      ] satisfies SkillFolderStatus[],
  });
  await findByText(messages.notice.missing);
  await findByText(messages.unusable);
  expect(
    getByRole("button", {
      name: messages.removeFolder.replace("{path}", () => "/skills/gone"),
    }),
  ).toBeDefined();
});

test("adding goes through the native picker, and a refused folder says why", async () => {
  const { calls, findByRole, findByText } = renderSection({
    list: () => [],
    pick: () => refuse("no_skill_file"),
  });
  const add = await findByRole("button", { name: messages.add });

  fireEvent.click(add);

  await findByText(messages.notice.no_skill_file);
  expect(calls).toContainEqual({
    command: "local_skill_folders_pick",
    args: {},
  });
});

test("a list of an unknown shape is not shown", async () => {
  const { container, calls } = renderSection({
    list: () => [{ path: 1 }],
  });
  await waitFor(() => {
    expect(
      calls.some(({ command }) => command === "local_skill_folders_get"),
    ).toBe(true);
  });
  expect(container.querySelector("section")).toBeNull();
});
