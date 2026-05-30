/**
 * Architecture test — folio render-pipeline layer boundaries.
 *
 * Defence in depth alongside the `folio-layer-boundaries` oxlint plugin.
 * Lint can be silenced (config edit, file-scoped disable, or a config typo);
 * this test asserts the same invariants on the actual file tree and fails
 * the test suite regardless of the lint state.
 *
 * Boundary rules — see `/tmp/folio-module-boundaries-design.md`:
 *
 *   layout-painter -> layout-bridge        : FORBIDDEN
 *   layout-painter -> layout-engine        : only `layout-engine/types`
 *                                            and `layout-engine/measure`
 *   layout-bridge  -> layout-painter       : FORBIDDEN
 *   layout-engine  -> layout-painter       : FORBIDDEN
 *   layout-engine  -> layout-bridge        : FORBIDDEN
 *
 * Negative tests use synthetic fixture strings to prove the analyser flags
 * the offending edges; the lint plugin's leading comment block lists the
 * same examples.
 */

import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";

const CORE_DIR = resolve(import.meta.dir, "..");

type Layer = "painter" | "bridge" | "engine";

const LAYER_DIRS: Record<Layer, string> = {
  painter: "layout-painter",
  bridge: "layout-bridge",
  engine: "layout-engine",
};

const LAYER_NAMES: Record<Layer, string> = {
  painter: "layout-painter",
  bridge: "layout-bridge",
  engine: "layout-engine",
};

const ALLOWED_PAINTER_TO_ENGINE_SEAMS = [
  "layout-engine/types",
  "layout-engine/measure",
];

const LAYER_ORDER: readonly Layer[] = ["painter", "bridge", "engine"];

const matchesLayerDir = (normalizedPath: string, layerDir: string): boolean =>
  normalizedPath.includes(`/core/${layerDir}/`) ||
  normalizedPath.endsWith(`/core/${layerDir}`);

const layerOfPath = (absolutePath: string): Layer | null => {
  const normalized = absolutePath.replaceAll("\\", "/");
  for (const name of LAYER_ORDER) {
    if (matchesLayerDir(normalized, LAYER_DIRS[name])) {
      return name;
    }
  }
  return null;
};

// Match the specifier of every static import/export, bare side-effect import
// (`import "../setup"`), and dynamic import (`import("../setup")`). The
// literal `from ` elsewhere in the file (e.g. inside comments) is filtered
// later by the
// `specifier.startsWith(".")` check — only relative paths are checked. The
// regex itself uses bounded character classes to keep matching linear.
const IMPORT_REGEX =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;

type EdgeViolation = {
  importer: string;
  specifier: string;
  resolvedTarget: string;
  fromLayer: Layer;
  toLayer: Layer;
  reason: string;
};

const violationsForFile = (filePath: string): EdgeViolation[] =>
  violationsForSource(filePath, readFileSync(filePath, "utf-8"));

const violationsForSource = (
  filePath: string,
  source: string,
): EdgeViolation[] => {
  const fromLayer = layerOfPath(filePath);
  if (fromLayer === null) {
    return [];
  }
  const violations: EdgeViolation[] = [];
  for (const match of source.matchAll(IMPORT_REGEX)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier === undefined || !specifier.startsWith(".")) {
      continue;
    }
    const resolvedTarget = posix.normalize(
      posix.join(dirname(filePath).replaceAll("\\", "/"), specifier),
    );
    const toLayer = layerOfPath(resolvedTarget);
    if (toLayer === null || toLayer === fromLayer) {
      continue;
    }

    const reason = classifyEdge(fromLayer, toLayer, resolvedTarget);
    if (reason !== null) {
      violations.push({
        importer: filePath,
        specifier,
        resolvedTarget,
        fromLayer,
        toLayer,
        reason,
      });
    }
  }
  return violations;
};

const classifyEdge = (
  fromLayer: Layer,
  toLayer: Layer,
  resolvedTarget: string,
): string | null => {
  if (fromLayer === "painter" && toLayer === "bridge") {
    return `${LAYER_NAMES.painter} must not import from ${LAYER_NAMES.bridge}`;
  }
  if (fromLayer === "painter" && toLayer === "engine") {
    if (matchesAllowedPainterToEngineSeam(resolvedTarget)) {
      return null;
    }
    const allowed = ALLOWED_PAINTER_TO_ENGINE_SEAMS.join(" or ");
    return `${LAYER_NAMES.painter} may only reach ${LAYER_NAMES.engine} via ${allowed}`;
  }
  if (fromLayer === "bridge" && toLayer === "painter") {
    return `${LAYER_NAMES.bridge} must not import from ${LAYER_NAMES.painter}`;
  }
  if (fromLayer === "engine" && toLayer === "painter") {
    return `${LAYER_NAMES.engine} must not import from ${LAYER_NAMES.painter}`;
  }
  if (fromLayer === "engine" && toLayer === "bridge") {
    return `${LAYER_NAMES.engine} must not import from ${LAYER_NAMES.bridge}`;
  }
  return null;
};

const matchesAllowedPainterToEngineSeam = (resolvedTarget: string): boolean => {
  const normalized = resolvedTarget.replaceAll("\\", "/");
  for (const seam of ALLOWED_PAINTER_TO_ENGINE_SEAMS) {
    if (
      normalized.endsWith(`/${seam}`) ||
      normalized.endsWith(`/${seam}.ts`) ||
      normalized.endsWith(`/${seam}.tsx`) ||
      normalized.endsWith(`/${seam}/index.ts`) ||
      normalized.includes(`/${seam}/`)
    ) {
      return true;
    }
  }
  return false;
};

const collectCoreFiles = (): string[] => {
  const glob = new Glob("**/*.{ts,tsx}");
  const files: string[] = [];
  for (const relative of glob.scanSync({ cwd: CORE_DIR })) {
    files.push(resolve(CORE_DIR, relative));
  }
  return files;
};

describe("folio render-pipeline layer boundaries", () => {
  test("no cross-layer violations on main", () => {
    const violations = collectCoreFiles().flatMap(violationsForFile);
    if (violations.length > 0) {
      const formatted = violations
        .map(
          (v) =>
            `  ${v.importer.replace(CORE_DIR, "<core>")}\n` +
            `    -> "${v.specifier}"\n` +
            `    ${v.reason}`,
        )
        .join("\n");
      throw new Error(
        `Folio layer-boundary violations found:\n${formatted}\n\n` +
          `See the design doc and \`.oxlint-plugins/folio-layer-boundaries.ts\` ` +
          `for the migration guidance.`,
      );
    }
    expect(violations).toEqual([]);
  });

  test("painter is allowed to import from layout-engine/types", () => {
    const fakePainter = resolve(CORE_DIR, "layout-painter/renderPage.ts");
    const specifier = "../layout-engine/types";
    const target = posix.normalize(
      posix.join(dirname(fakePainter).replaceAll("\\", "/"), specifier),
    );
    expect(matchesAllowedPainterToEngineSeam(target)).toBe(true);
    expect(
      classifyEdge("painter", layerOfPath(target) ?? "engine", target),
    ).toBeNull();
  });

  test("painter is allowed to import from layout-engine/measure", () => {
    const fakePainter = resolve(CORE_DIR, "layout-painter/renderPage.ts");
    const specifier = "../layout-engine/measure";
    const target = posix.normalize(
      posix.join(dirname(fakePainter).replaceAll("\\", "/"), specifier),
    );
    expect(matchesAllowedPainterToEngineSeam(target)).toBe(true);
    expect(
      classifyEdge("painter", layerOfPath(target) ?? "engine", target),
    ).toBeNull();
  });
});

describe("folio layer-boundaries — synthetic violation fixtures", () => {
  // Each fixture proves that `classifyEdge` (the shared rule used by the
  // architecture test AND mirrored by the oxlint plugin) actually flags the
  // forbidden edges. If a future refactor relaxes the rule by accident,
  // these fail loudly.

  test("painter -> bridge is rejected", () => {
    const target = resolve(CORE_DIR, "layout-bridge/measuring/index.ts");
    expect(
      classifyEdge("painter", layerOfPath(target) ?? "bridge", target),
    ).toBe("layout-painter must not import from layout-bridge");
  });

  test("painter -> bridge side-effect import is rejected", () => {
    const importer = resolve(CORE_DIR, "layout-painter/renderPage.ts");
    const violations = violationsForSource(
      importer,
      'import "../layout-bridge/setup";',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe(
      "layout-painter must not import from layout-bridge",
    );
  });

  test("painter -> bridge dynamic import is rejected", () => {
    const importer = resolve(CORE_DIR, "layout-painter/renderPage.ts");
    const violations = violationsForSource(
      importer,
      'const module = await import("../layout-bridge/measuring");',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe(
      "layout-painter must not import from layout-bridge",
    );
  });

  test("painter -> bridge barrel is rejected", () => {
    const target = resolve(CORE_DIR, "layout-bridge");
    expect(layerOfPath(target)).toBe("bridge");
    expect(
      classifyEdge("painter", layerOfPath(target) ?? "bridge", target),
    ).toBe("layout-painter must not import from layout-bridge");
  });

  test("painter -> engine internals (non-seam) is rejected", () => {
    const target = resolve(CORE_DIR, "layout-engine/paginator.ts");
    const reason = classifyEdge(
      "painter",
      layerOfPath(target) ?? "engine",
      target,
    );
    expect(reason).toContain("may only reach layout-engine via");
  });

  test("painter -> engine textBoxFlow is rejected (must go through /types)", () => {
    const target = resolve(CORE_DIR, "layout-engine/textBoxFlow.ts");
    const reason = classifyEdge(
      "painter",
      layerOfPath(target) ?? "engine",
      target,
    );
    expect(reason).toContain("may only reach layout-engine via");
  });

  test("bridge -> painter is rejected", () => {
    const target = resolve(CORE_DIR, "layout-painter/renderPage.ts");
    expect(
      classifyEdge("bridge", layerOfPath(target) ?? "painter", target),
    ).toBe("layout-bridge must not import from layout-painter");
  });

  test("engine -> painter is rejected", () => {
    const target = resolve(CORE_DIR, "layout-painter/renderPage.ts");
    expect(
      classifyEdge("engine", layerOfPath(target) ?? "painter", target),
    ).toBe("layout-engine must not import from layout-painter");
  });

  test("engine -> bridge is rejected", () => {
    const target = resolve(CORE_DIR, "layout-bridge/footnoteLayout.ts");
    expect(
      classifyEdge("engine", layerOfPath(target) ?? "bridge", target),
    ).toBe("layout-engine must not import from layout-bridge");
  });

  test("engine -> bridge barrel is rejected", () => {
    const target = resolve(CORE_DIR, "layout-bridge");
    expect(layerOfPath(target)).toBe("bridge");
    expect(
      classifyEdge("engine", layerOfPath(target) ?? "bridge", target),
    ).toBe("layout-engine must not import from layout-bridge");
  });

  test("the file walker flags a synthetic painter -> bridge edge", () => {
    // Simulate a synthetic file inside layout-painter that imports
    // from layout-bridge. We construct the fixture path lexically so we
    // do not have to write/clean up a real file.
    const fixturePath = resolve(CORE_DIR, "layout-painter/__synthetic__.ts");
    const synthetic = `import { x } from "../layout-bridge/measuring";\n`;
    // Re-implement the walker's body inline so we can feed a string.
    const fromLayer = layerOfPath(fixturePath);
    expect(fromLayer).toBe("painter");
    const matches = [...synthetic.matchAll(IMPORT_REGEX)];
    expect(matches.length).toBe(1);
    const specifier = matches[0]?.[1];
    expect(specifier).toBe("../layout-bridge/measuring");
    const resolved = posix.normalize(
      posix.join(dirname(fixturePath).replaceAll("\\", "/"), specifier ?? ""),
    );
    const toLayer = layerOfPath(resolved);
    expect(toLayer).toBe("bridge");
    expect(
      classifyEdge(fromLayer ?? "painter", toLayer ?? "bridge", resolved),
    ).toBe("layout-painter must not import from layout-bridge");
  });
});
