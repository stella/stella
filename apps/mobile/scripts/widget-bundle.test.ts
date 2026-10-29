import { expect, test } from "bun:test";
import fc from "fast-check";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { assertProperty } from "@stll/property-testing";

import {
  appConfigFor,
  configureWidgetsPodfile,
  WIDGETS_BUNDLE_HOOK,
} from "../app.config";

const APP_ROOT = path.resolve(import.meta.dir, "..");

test("the widget build uses an app-owned Metro config and retains runtime stubs", () => {
  const result = spawnSync(
    "node",
    [
      "-e",
      `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const app = require('./metro.config.cjs');
    const widgets = require('./widgets.metro.config.cjs');
    assert.equal(widgets.projectRoot, process.cwd());
    for (const folder of app.watchFolders) assert(widgets.watchFolders.includes(folder));
    const empty = app.resolver.emptyModulePath;
    assert(widgets.watchFolders.some(folder => {
      const relative = path.relative(folder, empty);
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    }), 'Metro empty module must be inside a watched root');
    const requests = [];
    const context = {
      originModulePath: path.join(process.cwd(), 'src/widgets/timer-activity.ios.tsx'),
      resolveRequest: (context, name, platform) => {
        requests.push({name, platform});
        return { type: 'sourceFile', filePath: name };
      },
    };
    assert(widgets.resolver.resolveRequest(context, 'react', 'ios').filePath.endsWith('react-stub.ts'));
    assert.deepEqual(widgets.resolver.resolveRequest(context, 'react-native/internal', 'ios'), {type: 'empty'});
    assert.deepEqual(requests, []);
    widgets.resolver.resolveRequest(context, empty, 'ios');
    widgets.resolver.resolveRequest(context, '@stll/locales', 'ios');
    assert.deepEqual(requests, [{name: empty, platform: 'ios'}, {name: '@stll/locales', platform: 'ios'}]);
  `,
    ],
    { cwd: APP_ROOT, encoding: "utf-8" },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);

  const build = readFileSync(
    path.join(import.meta.dir, "build-widget-bundle.mjs"),
    "utf-8",
  );
  expect(build).toMatch(
    /EXPO_OVERRIDE_METRO_CONFIG:\s*path\.join\(\s*projectRoot,\s*"widgets\.metro\.config\.cjs",?\s*\)/u,
  );
  const phase = readFileSync(
    path.join(import.meta.dir, "xcode-widget-bundle.sh"),
    "utf-8",
  );
  expect(phase).toContain('"$PROJECT_ROOT/scripts/build-widget-bundle.mjs"');
  expect(phase).not.toContain("/scripts/build-bundle.mjs");
});

test.each([0, 1, 2])(
  "CocoaPods rewires every widget phase and rejects missing phases (%i)",
  (count) => {
    const result = spawnSync(
      "ruby",
      [
        "-e",
        `
    Phase = Struct.new(:name, :shell_script)
    Target = Struct.new(:shell_script_build_phases)
    class Project
      attr_reader :targets, :saved
      def initialize(targets)
        @targets = targets
      end
      def save
        @saved = true
      end
    end
    Installer = Struct.new(:pods_project)
    def post_integrate
      other = Phase.new('Prepare ExpoWidgets Resources', 'untouched')
      widgets = Array.new(${count}) { Phase.new('[CP-User] Build ExpoWidgets Bundle', 'upstream') }
      project = Project.new([Target.new([other]), *widgets.map { |phase| Target.new([phase]) }])
      yield Installer.new(project)
      abort 'project not saved' unless project.saved
      abort 'other phase changed' unless other.shell_script == 'untouched'
      widgets.each do |phase|
        abort 'external bundle script' unless phase.shell_script == 'bash "$PODS_ROOT/../../scripts/xcode-widget-bundle.sh"'
      end
    end
    ${WIDGETS_BUNDLE_HOOK}
  `,
      ],
      { encoding: "utf-8" },
    );
    if (count === 0) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("ExpoWidgets bundle phase missing");
      return;
    }
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  },
);

test("app builds install the widget bundle hook even without an extension", () => {
  for (const variant of ["development", "preview", "production"] as const) {
    const inputs = {
      buildNumber: 1,
      runtimeVersion: "test",
      signingCertificatePresent: false,
      variant,
    };
    const config = appConfigFor(inputs);
    expect(Object.keys(config.mods?.ios ?? {})).toContain("podfile");
    const withoutWidgets = appConfigFor({
      ...inputs,
      signing: { profileUuid: "profile", teamId: "TEAM" },
    });
    expect(Object.keys(withoutWidgets.mods?.ios ?? {})).toContain("podfile");
  }
});

const podfileContents = fc.oneof(
  fc.string({ maxLength: 256 }),
  fc.string({ maxLength: 256 }).map((prefix) => prefix + WIDGETS_BUNDLE_HOOK),
);

test("widget Podfile generation preserves contents and reaches a fixed point", async () => {
  await assertProperty(
    "widget Podfile generation preserves contents and reaches a fixed point",
    fc.asyncProperty(podfileContents, async (contents) => {
      const config = { name: "stella", slug: "stella" };
      const expected = contents.includes(WIDGETS_BUNDLE_HOOK)
        ? contents
        : contents + WIDGETS_BUNDLE_HOOK;
      const generated = await configureWidgetsPodfile({
        ...config,
        modRawConfig: config,
        modRequest: {
          projectRoot: APP_ROOT,
          platformProjectRoot: path.join(APP_ROOT, "ios"),
          modName: "podfile",
          platform: "ios",
          introspect: false,
        },
        modResults: {
          path: path.join(APP_ROOT, "ios/Podfile"),
          contents,
          language: "rb",
        },
      });
      expect(generated.modResults.contents).toBe(expected);
      const replayed = await configureWidgetsPodfile(generated);
      expect(replayed.modResults.contents).toBe(expected);
    }),
  );
});
