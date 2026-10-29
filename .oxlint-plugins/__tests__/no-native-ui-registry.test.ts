import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import oxlintConfig from "../../oxlint.config.ts";
import {
  isRecord,
  readScopes,
  ruleIsOff,
  stringArray,
} from "../../scripts/oxlint-config-scopes.ts";
import { flattenLayers } from "../../scripts/oxlint-effective-config.ts";
import {
  DESIGN_SYSTEM_CONSUMER_FILES,
  REACT_NATIVE_CONSUMER_FILES,
} from "../../scripts/product-frontend-files.ts";
import {
  nativeEntries,
  nativeRuleId,
  nativeRuleName,
  NO_NATIVE_UI_PLUGIN,
  NO_NATIVE_UI_REACT_NATIVE,
  NO_NATIVE_UI_REGISTRY,
  type NoNativeUiEntry,
  type ReactNativeColumn,
  reactNativeRuleModules,
  registryKeyForExport,
} from "../no-native-ui-registry.ts";
import plugin from "../no-native-ui.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const UI_PACKAGE = "@stll/ui";
const FIXTURE = ".oxlint-plugins/__fixtures__/no-native-ui.fixture.tsx";

const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(ROOT, file), "utf-8"));

const uiManifest = readJson("packages/ui/package.json");
const uiExports =
  isRecord(uiManifest) && isRecord(uiManifest.exports)
    ? uiManifest.exports
    : {};

/** Where one export resolves: the string target, or its import condition. */
const exportTarget = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return null;
  }
  for (const condition of ["import", "default", "types"]) {
    const target = exportTarget(value[condition]);
    if (target !== null) {
      return target;
    }
  }
  return null;
};

const REGISTRY: Record<string, NoNativeUiEntry> = NO_NATIVE_UI_REGISTRY;
const REACT_NATIVE: Record<string, ReactNativeColumn> =
  NO_NATIVE_UI_REACT_NATIVE;

/** Each export's React Native module, keyed by subpath, when it names one. */
const reactNativeTargets = Object.entries(uiExports).flatMap(
  ([subpath, value]) => {
    const target = isRecord(value) ? value["react-native"] : undefined;
    return typeof target === "string"
      ? [{ subpath, key: registryKeyForExport(subpath), target }]
      : [];
  },
);
const registryKeys = new Set(Object.keys(REGISTRY));
const exportKeys = new Set(Object.keys(uiExports).map(registryKeyForExport));
const generatedRuleIds = nativeEntries().map(({ module }) =>
  nativeRuleId(module),
);

const scopes = readScopes(oxlintConfig);
const layers = flattenLayers(oxlintConfig, "oxlint.config.ts");

/** Whether some scope or preset layer turns `ruleId` on. */
const isConfigured = (ruleId: string): boolean => {
  const spellings = new Set([ruleId, ruleId.replace(/^eslint\//u, "")]);
  return [...layers, ...scopes].some(({ rules }) =>
    Object.entries(rules).some(
      ([rule, value]) => spellings.has(rule) && !ruleIsOff(value),
    ),
  );
};

describe("no-native-ui registry", () => {
  test("every @stll/ui export has a row", () => {
    expect([...exportKeys].filter((key) => !registryKeys.has(key))).toEqual([]);
  });

  test("every row names an @stll/ui export", () => {
    expect([...registryKeys].filter((key) => !exportKeys.has(key))).toEqual([]);
  });

  test("a module that renders markup is classified as a component", () => {
    const misclassified = Object.entries(uiExports).flatMap(
      ([subpath, value]) => {
        const target = exportTarget(value) ?? "";
        const key = registryKeyForExport(subpath);
        const rendersMarkup =
          target.endsWith(".tsx") ||
          /\/(?:calendar|data-table|kanban)\//u.test(target);
        return rendersMarkup && REGISTRY[key]?.kind === "not-component"
          ? [subpath]
          : [];
      },
    );
    expect(misclassified).toEqual([]);
  });

  test("the plugin exports exactly one rule per native row", () => {
    expect(Object.keys(plugin.rules).toSorted()).toEqual(
      nativeEntries()
        .map(({ module }) => nativeRuleName(module))
        .toSorted(),
    );
  });

  test("each rule name is wired to its own row", () => {
    const miswired = nativeEntries().flatMap(({ module, use }) => {
      const rule = plugin.rules[nativeRuleName(module)];
      const description = rule?.meta?.docs?.description;
      return description === use ? [] : [module];
    });
    expect(miswired).toEqual([]);
  });

  test("every row that defers names a configured rule", () => {
    const unconfigured = Object.entries(REGISTRY).flatMap(([module, entry]) =>
      entry.kind === "owned" && !isConfigured(entry.rule)
        ? [`${module} -> ${entry.rule}`]
        : [],
    );
    expect(unconfigured).toEqual([]);
  });

  test("a row that defers to a generated rule names one that exists", () => {
    const missing = Object.values(REGISTRY).flatMap((entry) =>
      entry.kind === "owned" &&
      entry.rule.startsWith(`${NO_NATIVE_UI_PLUGIN}/`) &&
      !generatedRuleIds.includes(entry.rule)
        ? [entry.rule]
        : [],
    );
    expect(missing).toEqual([]);
  });
});

describe("no-native-ui React Native column", () => {
  const components = Object.entries(REGISTRY).flatMap(([module, entry]) =>
    entry.kind === "not-component" ? [] : [module],
  );

  test("every component has a native renderer or a web-only reason", () => {
    expect(
      components.filter((module) => REACT_NATIVE[module] === undefined),
    ).toEqual([]);
    expect(
      Object.keys(REACT_NATIVE).filter(
        (module) => !components.includes(module),
      ),
    ).toEqual([]);
    expect(
      Object.entries(REACT_NATIVE).flatMap(([module, column]) =>
        column.kind === "web-only" && column.reason.trim().length < 12
          ? [module]
          : [],
      ),
    ).toEqual([]);
  });

  test("a renderer's every export resolves to its native module", () => {
    const missing = Object.entries(REACT_NATIVE).flatMap(([module, column]) => {
      if (column.kind !== "renderer") {
        return [];
      }
      const subpaths = Object.keys(uiExports).filter(
        (subpath) => registryKeyForExport(subpath) === module,
      );
      return subpaths.flatMap((subpath) => {
        const native = reactNativeTargets.find(
          (entry) => entry.subpath === subpath,
        );
        return native !== undefined &&
          native.target.endsWith(".native.tsx") &&
          existsSync(path.join(ROOT, "packages/ui", native.target))
          ? []
          : [subpath];
      });
    });
    expect(missing).toEqual([]);
  });

  test("a web-only component exports no native module", () => {
    expect(
      reactNativeTargets.flatMap(({ subpath, key }) =>
        REACT_NATIVE[key]?.kind === "renderer" ? [] : [subpath],
      ),
    ).toEqual([]);
  });

  test("each React Native component is claimed by one rule", () => {
    const selectors = nativeEntries().flatMap(({ reactNative }) => reactNative);
    expect(
      selectors.filter(
        (selector, index) => selectors.indexOf(selector) !== index,
      ),
    ).toEqual([]);
  });

  test("a renderer that replaces a React Native component generates its rule", () => {
    const ruleModules = new Set(nativeEntries().map(({ module }) => module));
    expect(
      Object.entries(REACT_NATIVE).flatMap(([module, column]) =>
        column.kind === "renderer" &&
        column.replaces.length > 0 &&
        !ruleModules.has(module)
          ? [module]
          : [],
      ),
    ).toEqual([]);
  });
});

describe("no-native-ui production scope", () => {
  test("the plugin is registered", () => {
    expect(stringArray(oxlintConfig.jsPlugins)).toContain(
      "./.oxlint-plugins/no-native-ui.ts",
    );
  });

  test("every generated rule is an error across every consumer surface", () => {
    const productScope = scopes.find(
      ({ files }) =>
        files.length === DESIGN_SYSTEM_CONSUMER_FILES.length &&
        DESIGN_SYSTEM_CONSUMER_FILES.every((glob) => files.includes(glob)),
    );
    expect(productScope).toBeDefined();
    const notError = generatedRuleIds.filter(
      (rule) => productScope?.rules[rule] !== "error",
    );
    expect(notError).toEqual([]);
  });

  test("every React Native rule is an error across the app", () => {
    // Other scopes cover the app too; this is the one that sets these rules.
    const appScope = scopes.find(
      ({ files, rules }) =>
        files.length === REACT_NATIVE_CONSUMER_FILES.length &&
        REACT_NATIVE_CONSUMER_FILES.every((glob) => files.includes(glob)) &&
        Object.keys(rules).some((rule) =>
          rule.startsWith(`${NO_NATIVE_UI_PLUGIN}/`),
        ),
    );
    expect(appScope).toBeDefined();
    const wanted = reactNativeRuleModules().map(nativeRuleId);
    expect(wanted.length).toBeGreaterThan(0);
    expect(wanted.filter((rule) => appScope?.rules[rule] !== "error")).toEqual(
      [],
    );
    // A rule for a web-only component would name an import the app lacks.
    expect(
      Object.keys(appScope?.rules ?? {}).filter(
        (rule) =>
          rule.startsWith(`${NO_NATIVE_UI_PLUGIN}/`) && !wanted.includes(rule),
      ),
    ).toEqual([]);
  });

  test("every workspace that depends on @stll/ui is a consumer surface", () => {
    const workspaces = [
      ...new Bun.Glob("{apps,packages}/*/package.json").scanSync(ROOT),
    ].toSorted();
    const uncovered = workspaces.flatMap((manifestPath) => {
      const manifest = readJson(manifestPath);
      if (!isRecord(manifest) || manifest.name === UI_PACKAGE) {
        return [];
      }
      const dependsOnUi = [
        "dependencies",
        "devDependencies",
        "peerDependencies",
      ].some((field) => {
        const dependencies = manifest[field];
        return isRecord(dependencies) && UI_PACKAGE in dependencies;
      });
      const sourceGlob = `${path.dirname(manifestPath)}/src/**/*.{ts,tsx}`;
      return dependsOnUi &&
        ![...DESIGN_SYSTEM_CONSUMER_FILES, ...REACT_NATIVE_CONSUMER_FILES].some(
          (glob) => glob === sourceGlob,
        )
        ? [path.dirname(manifestPath)]
        : [];
    });
    expect(uncovered).toEqual([]);
  });

  test("the design system itself is out of scope", () => {
    expect(
      DESIGN_SYSTEM_CONSUMER_FILES.filter((glob) =>
        glob.startsWith("packages/ui/"),
      ),
    ).toEqual([]);
  });

  test("the passive fixture suppresses every generated rule", () => {
    const fixture = readFileSync(path.join(ROOT, FIXTURE), "utf-8");
    const unsuppressed = generatedRuleIds.filter(
      (rule) =>
        !new RegExp(
          `oxlint-disable-next-line ${rule.replaceAll("/", "\\/")}(?:\\s|$|\\*)`,
          "u",
        ).test(fixture),
    );
    expect(unsuppressed).toEqual([]);
  });
});
