import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { UI_LOCALES } from "@stll/locales";

import {
  placeQuickDictation,
  QUICK_DICTATION_FILES,
  QUICK_DICTATION_TARGETS,
  WIDGET_BUNDLE_END,
} from "../../modules/quick-dictation/plugin.ts";
import {
  DICTATION_ACTIVITY_CLOCK,
  quickDictationConfiguration,
} from "../state/quick-dictation";

// The native side of a dictation started outside the app
// (`modules/quick-dictation`) has no build in CI; these bind what it shares
// with the app's JavaScript and with expo-widgets.

const APP_ROOT = path.resolve(import.meta.dir, "../..");
const MODULE_IOS = path.join(APP_ROOT, "modules/quick-dictation/ios");
const TARGETS = path.join(APP_ROOT, QUICK_DICTATION_TARGETS);
const EXPO_WIDGETS = path.dirname(
  createRequire(path.join(APP_ROOT, "package.json")).resolve(
    "expo-widgets/package.json",
  ),
);

const swift = (folder: string) =>
  readdirSync(folder, { recursive: true, encoding: "utf-8" })
    .filter((name) => name.endsWith(".swift"))
    .map((name) => readFileSync(path.join(folder, name), "utf-8"))
    .join("\n");

/** A Swift declaration from its first line to its closing brace at the margin, without comments or blank lines. */
const declaration = (source: string, head: string) => {
  const start = source.indexOf(head);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}\n", start);
  return source
    .slice(start, end + 2)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"))
    .join("\n");
};

const byCodeUnit = (a: string | undefined, b: string | undefined) =>
  Number((a ?? "") > (b ?? "")) - Number((a ?? "") < (b ?? ""));

/** How Xcode's string catalogs write the app's name in a shortcut phrase. */
const APP_NAME_TOKEN = `\${applicationName}`;

type StringCatalog = {
  strings: Record<
    string,
    { localizations: Record<string, { stringUnit: { value: string } }> }
  >;
};

const catalog = (file: string): StringCatalog["strings"] => {
  const parsed: StringCatalog = JSON.parse(
    readFileSync(path.join(TARGETS, file), "utf-8"),
  );
  return parsed.strings;
};

describe("the native side of a dictation started outside the app", () => {
  test("declares expo-widgets' activity attributes exactly, so ActivityKit pairs them", () => {
    const head = "struct LiveActivityAttributes: ActivityAttributes {";
    expect(
      declaration(
        readFileSync(
          path.join(MODULE_IOS, "QuickDictationActivity.swift"),
          "utf-8",
        ),
        head,
      ),
    ).toBe(
      declaration(
        readFileSync(
          path.join(EXPO_WIDGETS, "ios/Widgets/WidgetLiveActivity.swift"),
          "utf-8",
        ),
        head,
      ),
    );
  });

  test("sets the clock the layout counts from, and reads the configuration the app writes", () => {
    const native = swift(MODULE_IOS);
    expect(native).toContain(
      `static let clockProp = "${DICTATION_ACTIVITY_CLOCK}"`,
    );
    const configuration = quickDictationConfiguration({
      labels: {
        cancel: "",
        finish: "",
        readyDetail: "",
        readyTitle: "",
        recordingDetail: "",
        recordingTitle: "",
      },
      link: "",
    });
    for (const key of Object.keys(configuration)) {
      expect(native).toContain(`object["${key}"]`);
    }
    const rules = declaration(native, "struct QuickDictationRules: Codable {");
    const fields = [...rules.matchAll(/^let (\w+): Double$/gmu)].map(
      (match) => match[1],
    );
    expect(fields.toSorted(byCodeUnit)).toEqual(
      Object.keys(configuration.rules).toSorted(byCodeUnit),
    );
  });

  test("every string the intent, the shortcut and the control show is translated into each app language", () => {
    const sources = swift(TARGETS);
    const keys = [
      ...sources.matchAll(
        /LocalizedStringResource\("([\w.]+)", table: "QuickDictation"\)/gu,
      ),
    ].map((match) => match[1] ?? "");
    expect(keys.length).toBeGreaterThan(0);
    const strings = catalog("shared/QuickDictation.xcstrings");
    expect(Object.keys(strings).toSorted(byCodeUnit)).toEqual(
      [...new Set(keys)].toSorted(byCodeUnit),
    );
    const phrases = [
      ...sources.matchAll(/^\s+"(.+\\\(\.applicationName\).*)",$/gmu),
    ].map((match) =>
      (match[1] ?? "").replace("\\(.applicationName)", () => APP_NAME_TOKEN),
    );
    expect(phrases.length).toBeGreaterThan(0);
    const shortcuts = catalog("app/AppShortcuts.xcstrings");
    expect(Object.keys(shortcuts).toSorted(byCodeUnit)).toEqual(
      phrases.toSorted(byCodeUnit),
    );
    for (const [key, entry] of [
      ...Object.entries(strings),
      ...Object.entries(shortcuts),
    ]) {
      expect([
        key,
        Object.keys(entry.localizations).toSorted(byCodeUnit),
      ]).toEqual([key, [...UI_LOCALES].toSorted(byCodeUnit)]);
      if (key.includes(APP_NAME_TOKEN)) {
        for (const { stringUnit } of Object.values(entry.localizations)) {
          expect(stringUnit.value).toContain(APP_NAME_TOKEN);
        }
      }
    }
  });

  test("places each target's files and joins the control to the widget bundle once", () => {
    const root = mkdtempSync(path.join(tmpdir(), "quick-dictation-"));
    try {
      const appFolder = path.join(root, "app");
      const widgetsFolder = path.join(root, "widgets");
      mkdirSync(appFolder);
      mkdirSync(widgetsFolder);
      // How expo-widgets ends the bundle it generates.
      const generator = readFileSync(
        path.join(EXPO_WIDGETS, "plugin/build/ios/withWidgetSourceFiles.js"),
        "utf-8",
      );
      expect(generator).toMatch(
        /\n {4}\$\{!isLastChunk \? .+ : `WidgetLiveActivity\(\)`\}\n {2}\}/u,
      );
      writeFileSync(
        path.join(widgetsFolder, "index.swift"),
        `@main\nstruct ExportWidgets0: WidgetBundle {\n  var body: some Widget {\n    TimerWidget()\n${WIDGET_BUNDLE_END}  }\n}`,
      );
      placeQuickDictation({ appFolder, projectRoot: APP_ROOT, widgetsFolder });
      placeQuickDictation({ appFolder, projectRoot: APP_ROOT, widgetsFolder });
      expect(readdirSync(appFolder).toSorted(byCodeUnit)).toEqual(
        QUICK_DICTATION_FILES.app
          .map((file) => path.basename(file))
          .toSorted(byCodeUnit),
      );
      expect(readdirSync(widgetsFolder).toSorted(byCodeUnit)).toEqual(
        [
          "index.swift",
          ...QUICK_DICTATION_FILES.widgets.map((file) => path.basename(file)),
        ].toSorted(byCodeUnit),
      );
      const bundle = readFileSync(
        path.join(widgetsFolder, "index.swift"),
        "utf-8",
      );
      expect(bundle.split("DictationControl()").length).toBe(2);
      expect(bundle).toContain(
        "    WidgetLiveActivity()\n    if #available(iOS 18.0, *) {\n      DictationControl()\n    }\n  }",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
