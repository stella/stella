import { panic } from "better-result";
import {
  IOSConfig,
  withDangerousMod,
  withInfoPlist,
  withXcodeProject,
} from "expo/config-plugins";
import type { ConfigPlugin } from "expo/config-plugins";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

// Loaded by Expo's config loader through `app.config.ts`, so this file
// imports npm packages only.

/** The sources the plugin places, from the app's root. */
export const QUICK_DICTATION_TARGETS = "modules/quick-dictation/ios/targets";

/**
 * What each target compiles. The intent is in both: the control names it in
 * the widget extension, and iOS runs it in the app.
 */
export const QUICK_DICTATION_FILES = {
  app: [
    "shared/DictateIntent.swift",
    "app/DictateAction.swift",
    "shared/QuickDictation.xcstrings",
  ],
  widgets: [
    "shared/DictateIntent.swift",
    "widgets/DictationControl.swift",
    "shared/QuickDictation.xcstrings",
  ],
} as const;

/**
 * The shortcut phrases in every app language. A string catalog of them
 * builds only for iOS 17 and later, so the app, which runs from 16.4,
 * carries them as one `AppShortcuts.strings` per language, written from
 * this catalog at prebuild.
 */
export const APP_SHORTCUTS_CATALOG = "app/AppShortcuts.xcstrings";

const APP_SHORTCUTS_STRINGS = "AppShortcuts.strings";

/** Where the per-language strings go, as Expo puts the app's own: `<project>/Supporting/<language>.lproj`. */
const SUPPORTING_FOLDER = "Supporting";

/** The parts of a string catalog the strings files are written from. */
const stringCatalogSchema = v.object({
  strings: v.record(
    v.string(),
    v.object({
      localizations: v.record(
        v.string(),
        v.object({ stringUnit: v.object({ value: v.string() }) }),
      ),
    }),
  ),
});

const stringsLiteral = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;

/** Each language's `AppShortcuts.strings`, from the phrases' string catalog. */
export const appShortcutsStrings = (
  catalog: string,
): Record<string, string> => {
  const { strings } = v.parse(stringCatalogSchema, JSON.parse(catalog));
  const files: Record<string, string[]> = {};
  for (const [phrase, { localizations }] of Object.entries(strings)) {
    for (const [language, { stringUnit }] of Object.entries(localizations)) {
      (files[language] ??= []).push(
        `${stringsLiteral(phrase)} = ${stringsLiteral(stringUnit.value)};`,
      );
    }
  }
  return Object.fromEntries(
    Object.entries(files).map(([language, lines]) => [
      language,
      `${lines.join("\n")}\n`,
    ]),
  );
};

const readAppShortcutsStrings = (projectRoot: string) =>
  appShortcutsStrings(
    readFileSync(
      path.join(projectRoot, QUICK_DICTATION_TARGETS, APP_SHORTCUTS_CATALOG),
      "utf-8",
    ),
  );

/** Writes each language's shortcut phrases to `<language>.lproj` in `supportingFolder`; returns the languages. */
export const writeAppShortcutsStrings = ({
  projectRoot,
  supportingFolder,
}: {
  projectRoot: string;
  supportingFolder: string;
}): string[] => {
  const files = readAppShortcutsStrings(projectRoot);
  for (const [language, contents] of Object.entries(files)) {
    const folder = path.join(supportingFolder, `${language}.lproj`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, APP_SHORTCUTS_STRINGS), contents);
  }
  return Object.keys(files);
};

/** How expo-widgets ends its generated widget bundle; the control joins it there. */
export const WIDGET_BUNDLE_END = "    WidgetLiveActivity()\n";
const WIDGET_BUNDLE_WITH_CONTROL = `${WIDGET_BUNDLE_END}    if #available(iOS 18.0, *) {\n      DictationControl()\n    }\n`;

/**
 * Dictation from the Action Button, Siri, Shortcuts and Control Center
 * (`modules/quick-dictation`): the App Intent and its phrases in the app
 * target, the Control Center control in the widget extension's bundle, and
 * the background audio a dictation started outside the app records under.
 * Registered before expo-widgets, so its mods run after the extension's
 * sources and target exist.
 */
export const withQuickDictation: ConfigPlugin<{ widgetsTarget: string }> = (
  config,
  { widgetsTarget },
) =>
  withXcodeProject(
    withDangerousMod(
      withInfoPlist(config, (mod) => {
        const modes = mod.modResults.UIBackgroundModes ?? [];
        mod.modResults.UIBackgroundModes = [...new Set([...modes, "audio"])];
        return mod;
      }),
      [
        "ios",
        (mod) => {
          const { platformProjectRoot, projectName, projectRoot } =
            mod.modRequest;
          const appFolder = path.join(
            platformProjectRoot,
            projectName ?? panic("The prebuild names no project"),
          );
          placeQuickDictation({
            appFolder,
            projectRoot,
            widgetsFolder: path.join(platformProjectRoot, widgetsTarget),
          });
          writeAppShortcutsStrings({
            projectRoot,
            supportingFolder: path.join(appFolder, SUPPORTING_FOLDER),
          });
          return mod;
        },
      ],
    ),
    (mod) => {
      const appGroup =
        mod.modRequest.projectName ?? panic("The prebuild names no project");
      addQuickDictationFiles(mod.modResults, { appGroup, widgetsTarget });
      addAppShortcutsStrings(mod.modResults, {
        appGroup,
        languages: Object.keys(
          readAppShortcutsStrings(mod.modRequest.projectRoot),
        ),
      });
      return mod;
    },
  );

/**
 * Copies each target's files into its folder of the native project and adds
 * the control to the widget bundle expo-widgets generated; stops the
 * prebuild when that bundle no longer ends as expected.
 */
export const placeQuickDictation = ({
  appFolder,
  projectRoot,
  widgetsFolder,
}: {
  appFolder: string;
  projectRoot: string;
  widgetsFolder: string;
}) => {
  for (const [folder, files] of [
    [appFolder, QUICK_DICTATION_FILES.app],
    [widgetsFolder, QUICK_DICTATION_FILES.widgets],
  ] as const) {
    for (const file of files) {
      cpSync(
        path.join(projectRoot, QUICK_DICTATION_TARGETS, file),
        path.join(folder, path.basename(file)),
      );
    }
  }
  const bundlePath = path.join(widgetsFolder, "index.swift");
  const bundle = readFileSync(bundlePath, "utf-8");
  if (bundle.includes(WIDGET_BUNDLE_WITH_CONTROL)) {
    return;
  }
  if (bundle.split(WIDGET_BUNDLE_END).length !== 2) {
    panic(
      `${bundlePath} no longer ends its widget bundle with one WidgetLiveActivity(); update modules/quick-dictation/plugin.ts`,
    );
  }
  writeFileSync(
    bundlePath,
    bundle.replace(WIDGET_BUNDLE_END, () => WIDGET_BUNDLE_WITH_CONTROL),
  );
};

/** The project the Xcode mod hands over, as Expo's own helpers type it (`xcode.d.ts`). */
type XcodeProject = Parameters<typeof IOSConfig.Target.getNativeTargets>[0];

/** Xcode compiles a string catalog only under its own file type. */
const STRING_CATALOG_TYPE = "text.json.xcstrings";

/**
 * Adds each target's files to its group and build phases. The app's group
 * has no folder of its own, so its files are named from the project's
 * root; the extension's group is its folder.
 */
const addQuickDictationFiles = (
  project: XcodeProject,
  { appGroup, widgetsTarget }: { appGroup: string; widgetsTarget: string },
) => {
  const [appUuid] = IOSConfig.Target.findFirstNativeTarget(project);
  const [widgetsUuid, widgets] = IOSConfig.Target.findNativeTargetByName(
    project,
    widgetsTarget,
  );
  // expo-widgets gives the extension a resources phase only for locales; a
  // missing one would send its files to the app's.
  if (!widgets.buildPhases.some(({ comment }) => comment === "Resources")) {
    project.addBuildPhase(
      [],
      "PBXResourcesBuildPhase",
      "Resources",
      widgetsUuid,
    );
  }
  for (const { files, group, prefix, targetUuid } of [
    {
      files: QUICK_DICTATION_FILES.app,
      group: appGroup,
      prefix: appGroup,
      targetUuid: appUuid,
    },
    {
      files: QUICK_DICTATION_FILES.widgets,
      group: widgetsTarget,
      prefix: "",
      targetUuid: widgetsUuid,
    },
  ]) {
    for (const file of files) {
      const filepath = path.posix.join(prefix, path.basename(file));
      if (file.endsWith(".swift")) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
          filepath,
          groupName: group,
          project,
          targetUuid,
        });
        continue;
      }
      IOSConfig.XcodeUtils.addResourceFileToGroup({
        filepath,
        groupName: group,
        isBuildFile: true,
        project,
        targetUuid,
      });
      markStringCatalog(project, filepath);
    }
  }
};

/**
 * Adds each language's `AppShortcuts.strings` to the app target, in the
 * `Supporting/<language>.lproj` group, as Expo adds the app's
 * `InfoPlist.strings`; a group that has one keeps it.
 */
export const addAppShortcutsStrings = (
  project: XcodeProject,
  { appGroup, languages }: { appGroup: string; languages: readonly string[] },
) => {
  const [appUuid] = IOSConfig.Target.findFirstNativeTarget(project);
  for (const language of languages) {
    const groupName = `${appGroup}/${SUPPORTING_FOLDER}/${language}.lproj`;
    IOSConfig.XcodeUtils.ensureGroupRecursively(project, groupName);
    // Skips a file its group already has, so a second prebuild adds none.
    IOSConfig.XcodeUtils.addResourceFileToGroup({
      filepath: `${language}.lproj/${APP_SHORTCUTS_STRINGS}`,
      groupName,
      isBuildFile: true,
      project,
      targetUuid: appUuid,
    });
  }
};

const markStringCatalog = (project: XcodeProject, filepath: string) => {
  const { PBXFileReference: references = {} } = project.hash.project.objects;
  for (const reference of Object.values(references)) {
    if (
      isFileReference(reference) &&
      typeof reference.path === "string" &&
      IOSConfig.XcodeUtils.unquote(reference.path) === filepath
    ) {
      reference.lastKnownFileType = STRING_CATALOG_TYPE;
    }
  }
};

const isFileReference = (
  value: unknown,
): value is { path?: unknown; lastKnownFileType?: unknown } =>
  typeof value === "object" && value !== null;
