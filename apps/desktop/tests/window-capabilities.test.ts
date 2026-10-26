import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { LOCAL_ONLY_FEATURES } from "./local-only-features";

const DESKTOP_ROOT = path.join(import.meta.dir, "..");
const ENTRY_MODULE = "src/mainview/main.tsx";
const INVOKE_COMMAND_PATTERN = /\binvoke(?:<[^>]+>)?\(\s*"([a-z_]+)"/gu;
const LOCAL_COMMAND_PREFIXES = LOCAL_ONLY_FEATURES.flatMap((feature) =>
  feature.commandOwners.map((owner) => owner.prefix),
).join("|");
/** Commands a local-only window routes through its own command helper. */
const ROUTED_COMMAND_PATTERN = new RegExp(
  `\\b(?:applySnapshotCommand|onCommand|runCommand)\\(\\s*"((?:${LOCAL_COMMAND_PREFIXES})[a-z_]+)"`,
  "gu",
);

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

/**
 * The branch `main.tsx` renders for a window, keyed by that window's
 * capability. Local-only windows come from their feature entry.
 */
const WINDOW_MODULES: Record<string, readonly string[]> = {
  ...Object.fromEntries(
    LOCAL_ONLY_FEATURES.flatMap((feature) =>
      Object.entries(feature.windowModules),
    ),
  ),
  "src-tauri/capabilities/default.json": [
    "src/mainview/App.tsx",
    "src/mainview/PermissionsSection.tsx",
    "src/mainview/ShortcutSetting.tsx",
    "src/shared/ShortcutRecorder.tsx",
    "src/shared/use-clipboard-shortcut.ts",
  ],
  "src-tauri/capabilities/accessibility-guide.json": [
    "src/onboarding/AccessibilityGuideApp.tsx",
  ],
  "src-tauri/capabilities/onboarding.json": [
    "src/onboarding/OnboardingApp.tsx",
    "src/onboarding/ConnectStep.tsx",
    "src/onboarding/HowItWorksStep.tsx",
    "src/onboarding/PermissionsStep.tsx",
    "src/onboarding/TryItStep.tsx",
    "src/mainview/PermissionsSection.tsx",
    "src/shared/ShortcutRecorder.tsx",
    "src/shared/use-clipboard-shortcut.ts",
  ],
};

/**
 * The static prompt windows Rust opens: plain HTML with no shell behind it,
 * so their capability is exactly the commands the page invokes and nothing
 * else. Keyed by capability, as above.
 */
const DIALOG_WINDOWS = {
  "src-tauri/capabilities/pdf-sign-dialog.json":
    "src/mainview/pdf-sign-dialog.html",
  "src-tauri/capabilities/selfhost-connect-dialog.json":
    "src/mainview/selfhost-connect-dialog.html",
  "src-tauri/capabilities/takeover-dialog.json":
    "src/mainview/takeover-dialog.html",
} as const satisfies Record<string, string>;

const readSource = async (sourcePath: string) =>
  readFile(path.join(DESKTOP_ROOT, sourcePath), "utf-8");

const invokedCommandsInSource = (source: string) =>
  [INVOKE_COMMAND_PATTERN, ROUTED_COMMAND_PATTERN].flatMap((pattern) =>
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

// Tauri takes a permission either as its identifier or as an object that
// carries the identifier with a scope.
const permissionIdentifier = (
  permission: unknown,
  capabilityPath: string,
): string => {
  if (typeof permission === "string") {
    return permission;
  }
  if (
    typeof permission === "object" &&
    permission !== null &&
    "identifier" in permission &&
    typeof permission.identifier === "string"
  ) {
    return permission.identifier;
  }
  throw new TypeError(
    `${capabilityPath} has a permission without an identifier: ${JSON.stringify(permission)}`,
  );
};

const capabilityPermissions = (
  capability: unknown,
  capabilityPath: string,
): Set<string> => {
  if (
    typeof capability !== "object" ||
    capability === null ||
    !("permissions" in capability) ||
    !Array.isArray(capability.permissions)
  ) {
    throw new TypeError(`Invalid Tauri capability: ${capabilityPath}`);
  }
  return new Set(
    capability.permissions.map((permission: unknown) =>
      permissionIdentifier(permission, capabilityPath),
    ),
  );
};

const grantedCommands = async (capabilityPath: string) =>
  capabilityPermissions(
    JSON.parse(await readSource(capabilityPath)),
    capabilityPath,
  );

const pluginPermissions = (permissions: ReadonlySet<string>) =>
  [...permissions].filter(
    (permission) => permission.includes(":") && !permission.startsWith("core:"),
  );

const assertGrantedCommands = ({
  commands,
  permissions,
  capabilityPath,
}: {
  commands: readonly string[];
  permissions: ReadonlySet<unknown>;
  capabilityPath: string;
}) => {
  for (const command of commands) {
    const permission = `allow-${command.replaceAll("_", "-")}`;
    if (!permissions.has(permission)) {
      throw new TypeError(`${capabilityPath} lacks ${permission}`);
    }
  }
};

describe("window Tauri capabilities", () => {
  test("the main webview has no plugin command authority", async () => {
    const permissions = await grantedCommands(
      "src-tauri/capabilities/default.json",
    );
    expect(pluginPermissions(permissions)).toEqual([]);
  });

  test("plugin authority counts in both permission entry shapes", () => {
    const capabilityPath = "fixture.json";
    expect(
      pluginPermissions(
        capabilityPermissions(
          {
            permissions: [
              "core:default",
              "allow-get-state",
              "updater:default",
              { identifier: "opener:allow-open-url", allow: [{ url: "*" }] },
              { identifier: "core:window:allow-close" },
            ],
          },
          capabilityPath,
        ),
      ),
    ).toEqual(["updater:default", "opener:allow-open-url"]);
    expect(() =>
      capabilityPermissions({ permissions: [{ allow: [] }] }, capabilityPath),
    ).toThrow(`${capabilityPath} has a permission without an identifier`);
  });

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
          [ENTRY_MODULE, ...SHELL_INVOKE_SOURCES, ...modules].map(
            invokedCommands,
          ),
        )
      ).flat();
      const permissions = await grantedCommands(capabilityPath);

      expect(commands.length).toBeGreaterThan(0);
      assertGrantedCommands({ commands, permissions, capabilityPath });
    },
  );

  test.each(Object.entries(WINDOW_MODULES))(
    "%s rejects a missing foreground activity permission",
    async (capabilityPath, modules) => {
      const commands = (
        await Promise.all(
          [ENTRY_MODULE, ...SHELL_INVOKE_SOURCES, ...modules].map(
            invokedCommands,
          ),
        )
      ).flat();
      expect(commands).toContain("account_record_use");
      const permissions = await grantedCommands(capabilityPath);
      assertGrantedCommands({ commands, permissions, capabilityPath });
      permissions.delete("allow-account-record-use");
      expect(() =>
        assertGrantedCommands({ commands, permissions, capabilityPath }),
      ).toThrow(`${capabilityPath} lacks allow-account-record-use`);
    },
  );

  test.each(Object.entries(DIALOG_WINDOWS))(
    "%s grants exactly the commands its dialog invokes",
    async (capabilityPath, dialogPath) => {
      const commands = invokedCommandsInSource(await readSource(dialogPath));
      const permissions = await grantedCommands(capabilityPath);

      expect(commands.length).toBeGreaterThan(0);
      // Equality, not containment: a prompt that reaches the user outside the
      // app's own window earns no permission it does not use.
      const byName = (left: string, right: string) => left.localeCompare(right);
      expect([...permissions].toSorted(byName)).toEqual(
        [...new Set(commands)]
          .map((command) => `allow-${command.replaceAll("_", "-")}`)
          .toSorted(byName),
      );
    },
  );
});
