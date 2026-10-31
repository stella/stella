import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { defaultPresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import { PresentationPrefsProvider } from "@/lib/account/presentation-prefs/provider";
import { createTestPresentationPrefsSync } from "@/lib/account/presentation-prefs/sync.test-fixtures";

import { useSharedInspectorPaneWidth } from "./pane-width-storage";

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
