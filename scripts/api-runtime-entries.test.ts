import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import {
  type Node,
  parseSource,
  walk,
} from "../packages/scripts/src/syntax-tree";
import { API_RUNTIME_ENTRIES, LOCAL_DEV_MODULES } from "./api-runtime-entries";
import { reachableGraphSources } from "./root-connection-shapes";

const ROOT = path.resolve(import.meta.dir, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf-8");

const packageEntries = (): string[] => {
  const manifest: unknown = JSON.parse(read("apps/api/package.json"));
  const scripts =
    typeof manifest === "object" &&
    manifest !== null &&
    "scripts" in manifest &&
    typeof manifest.scripts === "object" &&
    manifest.scripts !== null
      ? Object.values(manifest.scripts)
      : [];
  return scripts.flatMap((command) =>
    typeof command === "string"
      ? [
          // A preload configures a process; it does not start one.
          ...command
            .replaceAll(/--preload\s+\S+/gu, "")
            .matchAll(/(?:^|\s)(?:\.\/)?(src\/\S+\.ts)\b/gu),
        ].flatMap(([, file]) =>
          file === undefined ? [] : [`apps/api/${file}`],
        )
      : [],
  );
};

const imageEntries = (): string[] =>
  [...read("apps/api/Dockerfile").matchAll(/apps\/api\/src\/\S+\.ts/gu)].map(
    ([file]) => file,
  );

test("every API process the package scripts or the image start is a runtime entry", () => {
  const listed = API_RUNTIME_ENTRIES.map(({ file }) => file);
  const started = [...new Set([...packageEntries(), ...imageEntries()])];
  expect(started).toContain("apps/api/src/server.ts");
  expect(started.filter((file) => !listed.includes(file))).toEqual([]);
  // The list names no process that nothing starts and no missing file.
  expect(
    listed.filter(
      (file) => !started.includes(file) || !existsSync(path.join(ROOT, file)),
    ),
  ).toEqual([]);
  expect(listed.toSorted(compareCodeUnit)).toEqual(
    [...new Set(listed)].toSorted(compareCodeUnit),
  );
});

const LOCAL_DEV_FILES: ReadonlySet<string> = new Set(
  LOCAL_DEV_MODULES.map(({ file }) => file),
);

const localDevTarget = (from: string, specifier: string) => {
  let base: string | undefined;
  if (specifier.startsWith("@/api/")) {
    base = `apps/api/src/${specifier.slice("@/api/".length)}`;
  } else if (specifier.startsWith(".")) {
    base = path.posix.join(path.posix.dirname(from), specifier);
  }
  return base === undefined
    ? undefined
    : [base, `${base}.ts`, `${base}.tsx`].find((file) =>
        LOCAL_DEV_FILES.has(file),
      );
};

const importSpecifier = (node: Node): string | undefined => {
  if (
    node.type === "ImportDeclaration" ||
    ((node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration") &&
      node.source !== null)
  ) {
    return node.source?.value;
  }
  return node.type === "ImportExpression" &&
    node.source.type === "Literal" &&
    typeof node.source.value === "string"
    ? node.source.value
    : undefined;
};

const isLocalDevGuard = (node: Node) =>
  node.type === "CallExpression" &&
  node.callee.type === "Identifier" &&
  node.callee.name === "isLocalDevOpen" &&
  node.arguments.length === 0;

/** Imports of a local-dev module outside the consequent of `isLocalDevOpen()`. */
const unguardedLocalDevImports = (file: string, source: string) => {
  const findings: string[] = [];
  walk(parseSource(file, source).program, (node, ancestors) => {
    const specifier = importSpecifier(node);
    const target =
      specifier === undefined ? undefined : localDevTarget(file, specifier);
    if (target === undefined) {
      return undefined;
    }
    const chain = [...ancestors, node];
    // A static import always runs, so only a dynamic one can be guarded.
    const guarded =
      node.type === "ImportExpression" &&
      chain.some((ancestor, index) => {
        const child = chain.at(index + 1);
        return (
          (ancestor.type === "ConditionalExpression" ||
            ancestor.type === "IfStatement") &&
          ancestor.consequent === child &&
          isLocalDevGuard(ancestor.test)
        );
      });
    if (!guarded) {
      findings.push(`${file}: ${target}`);
    }
    return undefined;
  });
  return findings;
};

test("every import of a local-dev module sits behind isLocalDevOpen()", () => {
  const files = [
    ...new Bun.Glob("apps/api/{src,scripts}/**/*.{ts,tsx}").scanSync(ROOT),
  ].filter((file) => !/\.test\.tsx?$/u.test(file));
  expect(
    files.flatMap((file) => unguardedLocalDevImports(file, read(file))),
  ).toEqual([]);
  const routes = "apps/api/src/api-routes.ts";
  expect(
    unguardedLocalDevImports(
      routes,
      'const dev = isLocalDevOpen() ? await import("@/api/handlers/dev/routes") : undefined;',
    ),
  ).toEqual([]);
  for (const source of [
    'import { devRoutes } from "@/api/handlers/dev/routes";',
    'const dev = await import("@/api/handlers/dev/routes");',
    'const dev = isLocalDevOpen() ? undefined : await import("@/api/handlers/dev/routes");',
    'if (isOpen()) { await import("./handlers/dev/routes"); }',
  ]) {
    expect(unguardedLocalDevImports(routes, source)).toEqual([
      `${routes}: apps/api/src/handlers/dev/routes.ts`,
    ]);
  }
});

test("the write graph does not follow imports into local-dev modules", () => {
  const sources = new Map([
    [
      "apps/api/src/server.ts",
      'import "./api-routes"; const dev = isLocalDevOpen() ? await import("@/api/handlers/dev/routes") : undefined;',
    ],
    ["apps/api/src/api-routes.ts", "export const routes = [];"],
    [
      "apps/api/src/handlers/dev/routes.ts",
      'import "../../../scripts/seed-dev";',
    ],
    ["apps/api/scripts/seed-dev.ts", "export const seed = () => undefined;"],
  ]);
  const roots = ["apps/api/src/server.ts"];
  expect(
    [
      ...reachableGraphSources({
        sources,
        roots,
        localDevFiles: LOCAL_DEV_FILES,
      }),
    ].toSorted(compareCodeUnit),
  ).toEqual(["apps/api/src/api-routes.ts", "apps/api/src/server.ts"]);
  expect(
    reachableGraphSources({ sources, roots }).has(
      "apps/api/scripts/seed-dev.ts",
    ),
  ).toBe(true);
});
