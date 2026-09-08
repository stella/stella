import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DESKTOP_ROOT = path.join(import.meta.dir, "..");
const ENTRY_MODULE = "src/mainview/main.tsx";
const INVOKE_COMMAND_PATTERN = /\binvoke(?:<[^>]+>)?\(\s*"([a-z_]+)"/gu;
const SNAPSHOT_COMMAND_PATTERN =
  /\b(?:applySnapshotCommand|onCommand)\(\s*"(clipboard_[a-z_]+)"/gu;

/**
 * Command owners called by the shell before or outside its window branch.
 * The telemetry module is narrowed to the imported error reporter because its
 * timing reporter is reached only by the clipboard branch.
 */
const SHELL_INVOKE_SOURCES = [
  {
    entryImport: "../i18n",
    sourcePath: "src/i18n/index.tsx",
  },
  {
    entryImport: "../telemetry/desktop-telemetry",
    exportedBinding: "reportDesktopError",
    sourcePath: "src/telemetry/desktop-telemetry.ts",
  },
] as const;

/** The branch `main.tsx` renders for a window, keyed by that window's capability. */
const WINDOW_MODULES = {
  "src-tauri/capabilities/clipboard-editor.json": [
    "src/clipboard/ClipboardEditor.tsx",
    "src/clipboard/ClipboardImagePreview.tsx",
  ],
  "src-tauri/capabilities/clipboard.json": [
    "src/clipboard/ClipboardApp.tsx",
    "src/clipboard/ClipboardImagePreview.tsx",
    "src/registry/RegistrySearch.tsx",
  ],
  "src-tauri/capabilities/default.json": ["src/mainview/App.tsx"],
} as const satisfies Record<string, readonly string[]>;

const readSource = async (sourcePath: string) =>
  readFile(path.join(DESKTOP_ROOT, sourcePath), "utf-8");

const invokedCommandsInSource = (source: string) =>
  [INVOKE_COMMAND_PATTERN, SNAPSHOT_COMMAND_PATTERN].flatMap((pattern) =>
    [...source.matchAll(pattern)].flatMap((match) => {
      const command = match.at(1);
      return command ? [command] : [];
    }),
  );

const exportedBindingSource = (source: string, binding: string) => {
  const marker = `export const ${binding}`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new TypeError(`Missing ${marker}`);
  }
  const end = source.indexOf("\nexport const ", start + marker.length);
  return source.slice(start, end === -1 ? undefined : end);
};

const invokedCommands = async (
  invocationSource: (typeof SHELL_INVOKE_SOURCES)[number] | string,
) => {
  if (typeof invocationSource === "string") {
    return invokedCommandsInSource(await readSource(invocationSource));
  }
  const source = await readSource(invocationSource.sourcePath);
  if (!("exportedBinding" in invocationSource)) {
    return invokedCommandsInSource(source);
  }
  return invokedCommandsInSource(
    exportedBindingSource(source, invocationSource.exportedBinding),
  );
};

const grantedCommands = async (capabilityPath: string) => {
  const source = await readSource(capabilityPath);
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
  test.each(Object.entries(WINDOW_MODULES))(
    "%s grants every command its shell and branch invoke",
    async (capabilityPath, modules) => {
      const entrySource = await readSource(ENTRY_MODULE);
      for (const shellSource of SHELL_INVOKE_SOURCES) {
        expect(entrySource).toContain(`from "${shellSource.entryImport}"`);
        if ("exportedBinding" in shellSource) {
          expect(entrySource).toContain(shellSource.exportedBinding);
        }
      }
      const commands = (
        await Promise.all(
          [...SHELL_INVOKE_SOURCES, ...modules].map(invokedCommands),
        )
      ).flat();
      const permissions = await grantedCommands(capabilityPath);

      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        expect(permissions).toContain(`allow-${command.replaceAll("_", "-")}`);
      }
    },
  );
});
