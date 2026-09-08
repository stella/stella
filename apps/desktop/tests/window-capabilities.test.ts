import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DESKTOP_ROOT = path.join(import.meta.dir, "..");
const INVOKE_COMMAND_PATTERN = /\binvoke(?:<[^>]+>)?\(\s*"([a-z_]+)"/gu;
const SNAPSHOT_COMMAND_PATTERN =
  /\b(?:applySnapshotCommand|onCommand)\(\s*"(clipboard_[a-z_]+)"/gu;

/**
 * Modules every window reaches. `main.tsx` mounts one shell whatever the
 * window label is, and the shell settles the language before it renders a
 * branch, so a command the shell invokes has to be granted by every window
 * capability below and not only by the one the branch belongs to.
 */
const SHELL_MODULES = ["src/i18n/index.tsx"] as const;

/** The branch `main.tsx` renders for a window, keyed by that window's capability. */
const WINDOW_MODULES = {
  "src-tauri/capabilities/clipboard-editor.json": [
    "src/clipboard/ClipboardEditor.tsx",
    "src/clipboard/ClipboardImagePreview.tsx",
  ],
  "src-tauri/capabilities/clipboard.json": [
    "src/clipboard/ClipboardApp.tsx",
    "src/clipboard/ClipboardImagePreview.tsx",
  ],
  "src-tauri/capabilities/default.json": ["src/mainview/App.tsx"],
} as const satisfies Record<string, readonly string[]>;

const invokedCommands = async (sourcePath: string) => {
  const source = await readFile(path.join(DESKTOP_ROOT, sourcePath), "utf-8");
  return [INVOKE_COMMAND_PATTERN, SNAPSHOT_COMMAND_PATTERN].flatMap((pattern) =>
    [...source.matchAll(pattern)].flatMap((match) => {
      const command = match.at(1);
      return command ? [command] : [];
    }),
  );
};

const grantedCommands = async (capabilityPath: string) => {
  const source = await readFile(
    path.join(DESKTOP_ROOT, capabilityPath),
    "utf-8",
  );
  const capability: unknown = JSON.parse(source);
  if (
    typeof capability !== "object" ||
    capability === null ||
    !("permissions" in capability) ||
    !Array.isArray(capability.permissions)
  ) {
    throw new TypeError(`Invalid Tauri capability: ${capabilityPath}`);
  }
  return new Set(capability.permissions);
};

describe("window Tauri capabilities", () => {
  test.each(
    Object.entries(WINDOW_MODULES).flatMap(([capabilityPath, modules]) =>
      [...SHELL_MODULES, ...modules].map((sourcePath) => [
        sourcePath,
        capabilityPath,
      ]),
    ),
  )(
    "grants every command %s invokes in %s",
    async (sourcePath, capabilityPath) => {
      const commands = await invokedCommands(sourcePath);
      const permissions = await grantedCommands(capabilityPath);

      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        expect(permissions).toContain(`allow-${command.replaceAll("_", "-")}`);
      }
    },
  );
});
