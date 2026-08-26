import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DESKTOP_ROOT = path.join(import.meta.dir, "..");
const INVOKE_COMMAND_PATTERN = /\binvoke(?:<[^>]+>)?\(\s*"([a-z_]+)"/gu;
const SNAPSHOT_COMMAND_PATTERN =
  /\b(?:applySnapshotCommand|onCommand)\(\s*"(clipboard_[a-z_]+)"/gu;

const invokedClipboardCommands = async (sourcePath: string) => {
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

describe("clipboard Tauri capabilities", () => {
  test.each([
    ["src/clipboard/ClipboardApp.tsx", "src-tauri/capabilities/clipboard.json"],
    [
      "src/clipboard/ClipboardEditor.tsx",
      "src-tauri/capabilities/clipboard-editor.json",
    ],
  ])(
    "grants every command invoked by %s",
    async (sourcePath, capabilityPath) => {
      const commands = await invokedClipboardCommands(sourcePath);
      const permissions = await grantedCommands(capabilityPath);

      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        expect(permissions).toContain(`allow-${command.replaceAll("_", "-")}`);
      }
    },
  );
});
