import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import {
  globalSystemWorkAllowedImports,
  inspectGlobalSystemWorkSource,
  isGlobalSystemWorkTestSource,
  parseGlobalSystemWorkOwners,
  readGlobalSystemWorkInventory,
} from "./global-system-work-census";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const GLOBAL_SYSTEM_WORK_OWNERS = parseGlobalSystemWorkOwners(
  readFileSync(
    path.join(REPO_ROOT, "apps/api/src/lib/db/global-system-work.ts"),
    "utf-8",
  ),
  "apps/api/src/lib/db/global-system-work.ts",
);

describe("global system work source census", () => {
  test("every production caller is exactly the owner listed for its literal job", async () => {
    const { owners, importers, callSites } =
      await readGlobalSystemWorkInventory(REPO_ROOT);
    const expectedCallSites = Object.entries(owners)
      .map(([type, { owner }]) => ({ file: owner, type }))
      .toSorted(
        (left, right) =>
          compareCodeUnit(left.file, right.file) ||
          compareCodeUnit(left.type, right.type),
      );
    const productionCallSites = [
      ...new Map(
        callSites
          .filter(({ file }) => !isGlobalSystemWorkTestSource(file))
          .map((callSite) => [`${callSite.file}:${callSite.type}`, callSite]),
      ).values(),
    ].toSorted(
      (left, right) =>
        compareCodeUnit(left.file, right.file) ||
        compareCodeUnit(left.type, right.type),
    );
    const productionImporters = importers
      .filter((file) => !isGlobalSystemWorkTestSource(file))
      .toSorted(compareCodeUnit);
    const listedOwners = [
      ...new Set(Object.values(owners).map(({ owner }) => owner)),
    ].toSorted(compareCodeUnit);

    expect(productionCallSites).toEqual(expectedCallSites);
    expect(productionImporters).toEqual(listedOwners);
    expect(
      globalSystemWorkAllowedImports(REPO_ROOT)
        .map(({ path: file }) => file)
        .toSorted(compareCodeUnit),
    ).toEqual([...importers].toSorted(compareCodeUnit));
  });

  test("global job data can use shorthand while its intent stays literal", () => {
    const result = inspectGlobalSystemWorkSource(
      GLOBAL_SYSTEM_WORK_OWNERS,
      "apps/api/src/lib/flows/sync-flow-schedule-trigger.ts",
      'import {runGlobalSystemWork} from "@/api/lib/db/global-system-work"; export const run = (tx, originals) => runGlobalSystemWork(tx, {type: "flow-schedule-orphan-page", originals});',
    );
    expect(result.callSites.map(({ type }) => type)).toEqual([
      "flow-schedule-orphan-page",
    ]);
  });

  test("rejects a literal job call from a source outside the mapped owner", () => {
    const unownedSource = `
      import { runGlobalSystemWork as runGlobalWork } from "@/api/lib/db/global-system-work";
      runGlobalWork(tx, { type: "flow-schedule-orphan-page", originals: [] });
    `;

    expect(() =>
      inspectGlobalSystemWorkSource(
        GLOBAL_SYSTEM_WORK_OWNERS,
        "apps/api/src/lib/unowned-global-cleanup.ts",
        unownedSource,
      ),
    ).toThrow("is called outside its owner");
  });

  test("resolves sibling, normalized relative, and source-suffix imports to the guarded module", () => {
    const imports = [
      ...[
        "./global-system-work",
        "./global-system-work.ts",
        "./global-system-work.tsx",
        "./global-system-work.js",
        "./global-system-work.jsx",
        "./global-system-work.mts",
        "./global-system-work.cts",
        "./global-system-work.mjs",
        "./global-system-work.cjs",
      ].map((specifier) => ({
        file: "apps/api/src/lib/db/unowned-global-system-work.ts",
        specifier,
      })),
      ...[
        "../db/../db/global-system-work",
        "../db/../db/global-system-work.ts",
        "../db/../db/global-system-work.js",
      ].map((specifier) => ({
        file: "apps/api/src/lib/flows/unowned-global-system-work.ts",
        specifier,
      })),
      {
        file: "apps/api/src/lib/flows/unowned-global-system-work.ts",
        specifier: "@/api/lib/db/../db/global-system-work.ts",
      },
    ];

    for (const { file, specifier } of imports) {
      const source = `
        import { runGlobalSystemWork as run } from "${specifier}";
        run(tx, { type: "flow-schedule-orphan-page" });
      `;
      expect(() =>
        inspectGlobalSystemWorkSource(GLOBAL_SYSTEM_WORK_OWNERS, file, source),
      ).toThrow("is called outside its owner");
    }
  });

  test("rejects sibling and normalized relative re-exports of the guarded module", () => {
    for (const { file, specifier } of [
      {
        file: "apps/api/src/lib/db/unowned-global-system-work.ts",
        specifier: "./global-system-work",
      },
      {
        file: "apps/api/src/lib/flows/unowned-global-system-work.ts",
        specifier: "../db/../db/global-system-work.ts",
      },
    ]) {
      const source = `
        export { runGlobalSystemWork as run } from "${specifier}";
      `;
      expect(() =>
        inspectGlobalSystemWorkSource(GLOBAL_SYSTEM_WORK_OWNERS, file, source),
      ).toThrow("cannot re-export");
    }
  });

  test("shadowed helper names are not attributed to the imported function", () => {
    const shadowedSource = `
      import { runGlobalSystemWork as runGlobalWork } from "@/api/lib/db/global-system-work";
      const locallyDefined = (runGlobalWork) =>
        runGlobalWork(tx, { type: "flow-schedule-orphan-page", originals: [] });
    `;

    expect(() =>
      inspectGlobalSystemWorkSource(
        GLOBAL_SYSTEM_WORK_OWNERS,
        "apps/api/src/lib/flows/unowned-shadow.ts",
        shadowedSource,
      ),
    ).toThrow("without a direct call");
  });

  test("rejects escaped runtime references beside valid direct calls", () => {
    const escapedReferences = [
      `consume(runGlobalWork);`,
      `[runGlobalWork][0](tx, { type: "flow-schedule-orphan-page" });`,
      `runGlobalWork.call(null, tx, { type: "flow-schedule-orphan-page" });`,
      `runGlobalWork.apply(null, [tx, { type: "flow-schedule-orphan-page" }]);`,
      `const alias = runGlobalWork; consume(alias);`,
      `import * as jobs from "@/api/lib/db/global-system-work"; consume(jobs);`,
      `import * as jobs from "@/api/lib/db/global-system-work"; consume(jobs.runGlobalSystemWork);`,
      `import * as jobs from "@/api/lib/db/global-system-work"; jobs.runGlobalSystemWork.call(null, tx, { type: "flow-schedule-orphan-page" });`,
    ];

    for (const escapedReference of escapedReferences) {
      const source = `
        import { runGlobalSystemWork as runGlobalWork } from "@/api/lib/db/global-system-work";
        runGlobalWork(tx, { type: "flow-schedule-orphan-page" });
        ${escapedReference}
      `;
      expect(() =>
        inspectGlobalSystemWorkSource(
          GLOBAL_SYSTEM_WORK_OWNERS,
          "apps/api/src/lib/db/global-system-work.test.ts",
          source,
        ),
      ).toThrow("runGlobalSystemWork");
    }
  });

  test("rejects decoded require specifiers without an ESM import", () => {
    const sources = [
      'const jobs = require("@/api/lib/db/global\\u002dsystem\\u002dwork"); jobs.runGlobalSystemWork(tx, { type: "flow-schedule-orphan-page" });',
      'const jobs = r\\u0065quire("@/api/lib/db/global-system-work"); jobs.runGlobalSystemWork(tx, { type: "flow-schedule-orphan-page" });',
    ];
    for (const source of sources) {
      expect(() =>
        inspectGlobalSystemWorkSource(
          GLOBAL_SYSTEM_WORK_OWNERS,
          "apps/api/src/lib/unowned.ts",
          source,
        ),
      ).toThrow("cannot require runGlobalSystemWork");
    }
  });

  test.each([
    String.raw`r\u0065quire`,
    String.raw`\u0072equire`,
    String.raw`requ\u0069re`,
    String.raw`r\u{65}quire`,
    String.raw`\u{0000000072}equire`,
    String.raw`\u0072\u{65}\u0071\u0075\u0069\u0072\u0065`,
  ])(
    "rejects native require identifiers decoded from Unicode escapes: %s",
    (callee) => {
      expect(() =>
        inspectGlobalSystemWorkSource(
          GLOBAL_SYSTEM_WORK_OWNERS,
          "apps/api/src/lib/unowned.ts",
          `const jobs = ${callee}("@/api/lib/db/global-system-work"); jobs.runGlobalSystemWork(tx, {type: "flow-schedule-orphan-page"});`,
        ),
      ).toThrow("cannot require runGlobalSystemWork");
    },
  );

  test.each([
    String.raw`export const marker = "\u0301";`,
    String.raw`export const marker = /\u{1f680}/u;`,
    String.raw`// \u{110000} and \u{ffffffffffffffffffffffffffffffff}
      export const marker = true;`,
  ])(
    "unrelated Unicode escapes do not claim a guarded runtime import",
    (source) => {
      expect(
        inspectGlobalSystemWorkSource(
          GLOBAL_SYSTEM_WORK_OWNERS,
          "apps/api/src/lib/unrelated-unicode.test.ts",
          source,
        ),
      ).toEqual({ imported: false, callSites: [] });
    },
  );

  test("Unicode-only non-import files still reject invalid syntax", () => {
    expect(() =>
      inspectGlobalSystemWorkSource(
        GLOBAL_SYSTEM_WORK_OWNERS,
        "apps/api/src/lib/unrelated-unicode.test.ts",
        String.raw`const broken = ; const marker = "\u0301";`,
      ),
    ).toThrow("does not parse");
  });

  test("native ESM module records retain decoded static specifiers", () => {
    const file = "apps/api/src/lib/db/global-system-work.test.ts";
    expect(
      inspectGlobalSystemWorkSource(
        GLOBAL_SYSTEM_WORK_OWNERS,
        file,
        String.raw`import {runGlobalSystemWork} from "@/api/lib/db/global\u002dsystem\u002dwork";
        runGlobalSystemWork(tx, {type: "flow-schedule-orphan-page"});`,
      ).callSites,
    ).toEqual([{ file, type: "flow-schedule-orphan-page" }]);
  });

  test("keeps lexical shadowing separate from named and namespace imports", () => {
    const sources = [
      `
        import { runGlobalSystemWork as runGlobalWork } from "@/api/lib/db/global-system-work";
        runGlobalWork(tx, { type: "flow-schedule-orphan-page" });
        const local = (runGlobalWork) => consume(runGlobalWork);
      `,
      `
        import * as jobs from "@/api/lib/db/global-system-work";
        jobs.runGlobalSystemWork(tx, { type: "flow-schedule-orphan-page" });
        const local = (jobs) => consume(jobs);
      `,
    ];

    for (const source of sources) {
      expect(
        inspectGlobalSystemWorkSource(
          GLOBAL_SYSTEM_WORK_OWNERS,
          "apps/api/src/lib/db/global-system-work.test.ts",
          source,
        ).callSites,
      ).toHaveLength(1);
    }
  });

  test("reads only the top-level exported owner map, not a nested shadow", () => {
    expect(
      parseGlobalSystemWorkOwners(
        `
          const local = () => {
            const GLOBAL_SYSTEM_JOBS = {
              "flow-schedule-orphan-page": { owner: "wrong.ts" },
            };
            return GLOBAL_SYSTEM_JOBS;
          };
          export const GLOBAL_SYSTEM_JOBS = {
            "flow-schedule-orphan-page": { owner: "right.ts" },
          } as const;
        `,
        "fixture.ts",
      ),
    ).toEqual({ "flow-schedule-orphan-page": { owner: "right.ts" } });
  });

  test("ignores a type-only import as a runtime importer", () => {
    expect(
      inspectGlobalSystemWorkSource(
        GLOBAL_SYSTEM_WORK_OWNERS,
        "apps/api/src/lib/db/global-system-work-type.ts",
        `
          import { type runGlobalSystemWork } from "@/api/lib/db/global-system-work";
          type Runner = typeof runGlobalSystemWork;
        `,
      ),
    ).toEqual({ imported: false, callSites: [] });
  });

  test("recognizes an unaliased imported identifier as a direct call", () => {
    expect(
      inspectGlobalSystemWorkSource(
        GLOBAL_SYSTEM_WORK_OWNERS,
        "apps/api/src/lib/scheduler/tasks/flow-run.ts",
        `
          import { runGlobalSystemWork } from "@/api/lib/db/global-system-work";
          await runGlobalSystemWork(tx, {
            type: "flow-schedule-orphan-claim",
            definitionId: "definition",
            jobId: "job",
            lockedBy: "worker",
          });
        `,
      ).callSites,
    ).toEqual([
      {
        file: "apps/api/src/lib/scheduler/tasks/flow-run.ts",
        type: "flow-schedule-orphan-claim",
      },
    ]);
  });
});
