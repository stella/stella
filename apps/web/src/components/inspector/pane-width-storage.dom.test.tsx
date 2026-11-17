import { renderToStaticMarkup } from "react-dom/server";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { IntlProvider } from "use-intl";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import en from "@/i18n/langs/en.json";
import { defaultPresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import { createTestPresentationPrefsSync } from "@/lib/account/presentation-prefs/sync.test-fixtures";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

const { cleanup, render } = await import("@testing-library/react");
const { PresentationPrefsProvider } =
  await import("@/lib/account/presentation-prefs/provider");
const { useSharedInspectorPaneWidth } = await import("./pane-width-storage");
const { inspectorStateEntry, inspectorMinimizedEntry } =
  await import("@/components/inspector/inspector-storage-keys");
const { writePersistedState, removePersistedState } =
  await import("@/lib/persisted-state/registry");
const { ProtectedPendingSkeleton } =
  await import("@/routes/-protected-pending-skeleton");
const pendingScope = { organizationId: "pending-org", userId: "pending-user" };

afterEach(() => {
  cleanup();
  removePersistedState(inspectorStateEntry, pendingScope).unwrap();
  removePersistedState(inspectorMinimizedEntry, pendingScope).unwrap();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

const Dock = () => {
  const { width } = useSharedInspectorPaneWidth({
    sidebarWidth: 240,
    viewportWidth: 1920,
  });
  return <aside data-width={width} />;
};

describe("inspector width server snapshot", () => {
  test("all dock surfaces render the shared cookie width on the server", () => {
    for (const inspectorWidth of [320, 520, 610]) {
      const html = renderToStaticMarkup(
        <PresentationPrefsProvider
          initialPrefs={{ ...defaultPresentationPrefs, inspectorWidth }}
          sync={createTestPresentationPrefsSync({
            ...defaultPresentationPrefs,
            inspectorWidth,
          })}
        >
          <Dock />
          <Dock />
        </PresentationPrefsProvider>,
      );
      expect(
        html.match(new RegExp(`data-width="${inspectorWidth}"`, "gu")),
      ).toHaveLength(2);
    }
  });
});

test("the member loading frame reserves the saved inspector before tabs mount", () => {
  const prefs = { ...defaultPresentationPrefs, inspectorWidth: 320 };
  writePersistedState(inspectorStateEntry, pendingScope, {
    tabs: [
      {
        type: "chat",
        id: "00000000-0000-4000-8000-000000000001",
        label: "Chat",
        contextMatterIds: [],
      },
    ],
    groups: [],
    groupAssignments: {},
    activeId: "00000000-0000-4000-8000-000000000001",
    collapsedGroupIds: [],
  }).unwrap();
  writePersistedState(inspectorMinimizedEntry, pendingScope, false).unwrap();
  const sync = createTestPresentationPrefsSync(prefs);
  const frame = (scope: typeof pendingScope) => (
    <IntlProvider locale="en" messages={en}>
      <PresentationPrefsProvider initialPrefs={prefs} sync={sync}>
        <ProtectedPendingSkeleton inspectorScope={scope} />
      </PresentationPrefsProvider>
    </IntlProvider>
  );
  const { container, rerender } = render(frame(pendingScope));
  const dockWidth = () =>
    container
      .querySelector('[data-slot="inspector-pending-dock"]')
      ?.getAttribute("style");
  expect(dockWidth()).toBe("width: 320px;");
  rerender(frame({ ...pendingScope, userId: "another-user" }));
  expect(dockWidth()).toBeNull();
  writePersistedState(inspectorMinimizedEntry, pendingScope, true).unwrap();
  rerender(frame(pendingScope));
  expect(dockWidth()).toBeNull();
});

// A dock bypassing the shared hook would reintroduce independent persistence.
test("no source outside the owner keeps an inspector width of its own", async () => {
  const webRoot = nodePath.resolve(import.meta.dir, "../../..");
  const allowed = new Set([
    "src/components/inspector/pane-width-storage.ts",
    "src/lib/account/storage-families.ts",
    // The read-once migration recognizes old local storage keys.
    "src/i18n/legacy-preferences-migration.ts",
  ]);
  const offenders: string[] = [];
  for await (const file of new Bun.Glob("src/**/*.{ts,tsx}").scan(webRoot)) {
    if (allowed.has(file) || file.includes(".test.")) {
      continue;
    }
    const source = readFileSync(nodePath.join(webRoot, file), "utf-8");
    if (
      source.includes("inspector-pane-width:") ||
      /\buseInspectorPaneWidth\b/u.test(source)
    ) {
      offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});
