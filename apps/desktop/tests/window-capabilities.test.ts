import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { LOCAL_ONLY_FEATURES } from "./local-only-features";

const DESKTOP_ROOT = path.join(import.meta.dir, "..");
const ENTRY_MODULE = "src/mainview/main.tsx";
const INVOKE_COMMAND_PATTERN = /\binvoke(?:<[^>]+>)?\(\s*"([a-z_]+)"/gu;
const LOCAL_COMMAND_PREFIXES = LOCAL_ONLY_FEATURES.flatMap((feature) =>
  feature.commandOwners.flatMap((owner) => owner.prefixes),
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
 * capability. Local-only modules come from their feature entry, added to
 * any shell modules the same window renders.
 */
const SHELL_WINDOW_MODULES: Record<string, readonly string[]> = {
  "src-tauri/capabilities/default.json": [
    "src/mainview/App.tsx",
    "src/mainview/AgentSubscriptionsSection.tsx",
    "src/mainview/LocalSkillFoldersSection.tsx",
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

const WINDOW_MODULES: Record<string, readonly string[]> = {
  ...SHELL_WINDOW_MODULES,
};
for (const [capability, modules] of LOCAL_ONLY_FEATURES.flatMap((feature) =>
  Object.entries(feature.windowModules),
)) {
  WINDOW_MODULES[capability] = [
    ...(WINDOW_MODULES[capability] ?? []),
    ...modules,
  ];
}

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

/** Lets a page's drag strip move its window. */
const DRAG_PERMISSION = "core:window:allow-start-dragging";
const OVERLAY_TITLE_BAR = "TitleBarStyle::Overlay";

/**
 * The windows Rust opens with the macOS title bar under the page, keyed by
 * the module that builds each one. The page covers the native title bar, so
 * it draws the drag strip and its capability lets the strip move the window.
 */
const OVERLAY_TITLE_BAR_WINDOWS = {
  "src-tauri/src/activity_window.rs": {
    capability: "src-tauri/capabilities/activity.json",
    page: "src/activity/ActivityApp.tsx",
  },
  "src-tauri/src/clipboard_window.rs": {
    capability: "src-tauri/capabilities/clipboard-editor.json",
    page: "src/clipboard/ClipboardEditor.tsx",
  },
  "src-tauri/src/deep_link.rs": {
    capability: "src-tauri/capabilities/selfhost-connect-dialog.json",
    page: "src/mainview/selfhost-connect-dialog.html",
  },
  "src-tauri/src/lib.rs": {
    capability: "src-tauri/capabilities/default.json",
    page: "src/mainview/App.tsx",
  },
  "src-tauri/src/onboarding.rs": {
    capability: "src-tauri/capabilities/onboarding.json",
    page: "src/onboarding/OnboardingApp.tsx",
  },
  "src-tauri/src/pdf_signing.rs": {
    capability: "src-tauri/capabilities/pdf-sign-dialog.json",
    page: "src/mainview/pdf-sign-dialog.html",
  },
} as const satisfies Record<string, { capability: string; page: string }>;

const overlayCapabilities: ReadonlySet<string> = new Set(
  Object.values(OVERLAY_TITLE_BAR_WINDOWS).map((window) => window.capability),
);

/** A page draws the shared strip, or, as a static page, the attribute. */
const DRAG_STRIP_PATTERN =
  /<WindowDragRegion \/>|\sdata-tauri-drag-region(?=[\s=>])/u;

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
        [
          ...[...new Set(commands)].map(
            (command) => `allow-${command.replaceAll("_", "-")}`,
          ),
          ...(overlayCapabilities.has(capabilityPath) ? [DRAG_PERMISSION] : []),
        ].toSorted(byName),
      );
    },
  );

  test("every window under its title bar is registered with its drag strip", async () => {
    const glob = new Bun.Glob("src-tauri/src/**/*.rs");
    const overlayModules: string[] = [];
    for await (const modulePath of glob.scan({ cwd: DESKTOP_ROOT })) {
      const source = await readSource(modulePath);
      const count = source.split(OVERLAY_TITLE_BAR).length - 1;
      if (count > 0) {
        // One registration per window: a second one in a module would need
        // its own entry.
        expect({ count, modulePath }).toEqual({ count: 1, modulePath });
        overlayModules.push(modulePath);
      }
    }
    const byName = (left: string, right: string) => left.localeCompare(right);
    expect(overlayModules.toSorted(byName)).toEqual(
      Object.keys(OVERLAY_TITLE_BAR_WINDOWS).toSorted(byName),
    );
  });

  test.each(Object.entries(OVERLAY_TITLE_BAR_WINDOWS))(
    "%s window can be dragged by its page",
    async (_modulePath, { capability, page }) => {
      const source = await readSource(page);
      expect(DRAG_STRIP_PATTERN.test(source)).toBe(true);
      const permissions = await grantedCommands(capability);
      expect(permissions.has(DRAG_PERMISSION)).toBe(true);
    },
  );

  test("a page without its drag strip or permission is caught", () => {
    expect(DRAG_STRIP_PATTERN.test('<main className="pt-10">')).toBe(false);
    expect(DRAG_STRIP_PATTERN.test("<div data-tauri-drag-region-x>")).toBe(
      false,
    );
    expect(
      capabilityPermissions(
        { permissions: ["allow-activity-get-day"] },
        "fixture.json",
      ).has(DRAG_PERMISSION),
    ).toBe(false);
  });
});
