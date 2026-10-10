import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  listE2eSpecs,
  selectE2eSpecs,
  selectedE2ePlan,
} from "./e2e-spec-shards";
import { allE2eMatrix } from "./e2e-spec-shards-core";

const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "e2e-spec-shards-"));
  const write = (file: string, contents = "") => {
    const destination = path.join(root, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  };
  write("README.md");
  write(
    "apps/web/e2e/playwright.config.ts",
    'export default { testDir: "./specs" };\n',
  );
  write("apps/web/e2e/helpers/shared.ts", "export const shared = true;\n");
  write("apps/web/e2e/helpers/only-a.ts", "export const onlyA = true;\n");
  write("apps/web/e2e/helpers/index.ts", "export const helper = true;\n");
  write(
    "apps/web/e2e/specs/a.spec.ts",
    'import "../helpers";\nimport "../helpers/shared";\nimport "../helpers/only-a";\n',
  );
  write("apps/web/e2e/specs/b.spec.ts", 'import "../helpers/shared";\n');
  return { root, write };
};

describe("e2e spec shard selection", () => {
  test("full depth delegates distribution to both Playwright shards", () => {
    expect(allE2eMatrix()).toEqual({ shard: [1, 2, "network-baseline"] });
  });

  test.each(["a", "b"])("a changed spec %s runs in one PR leg", (name) => {
    const { root } = fixture();
    try {
      const spec = `apps/web/e2e/specs/${name}.spec.ts`;
      expect(selectedE2ePlan([spec], root)).toEqual({
        status: "selected",
        matrix: { shard: [1] },
        specs: [spec],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selects changed specs and every consumer of a changed helper", () => {
    const { root } = fixture();
    try {
      expect(selectE2eSpecs(["apps/web/e2e/specs/a.spec.ts"], root)).toEqual([
        "apps/web/e2e/specs/a.spec.ts",
      ]);
      expect(selectE2eSpecs(["apps/web/e2e/helpers/shared.ts"], root)).toEqual([
        "apps/web/e2e/specs/a.spec.ts",
        "apps/web/e2e/specs/b.spec.ts",
      ]);
      expect(
        selectedE2ePlan(["apps/web/e2e/helpers/shared.ts"], root).matrix.shard,
      ).toEqual([1]);
      expect(selectE2eSpecs(["apps/web/e2e/helpers/index.ts"], root)).toEqual([
        "apps/web/e2e/specs/a.spec.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selects nothing for resolved unrelated changes and widens for deleted files", () => {
    const { root, write } = fixture();
    try {
      expect(selectE2eSpecs(["README.md"], root)).toEqual([]);
      expect(selectedE2ePlan(["README.md"], root)).toEqual({
        status: "selected",
        matrix: { shard: [] },
        specs: [],
      });
      write("apps/web/e2e/specs/deleted.spec.ts");
      rmSync(path.join(root, "apps/web/e2e/specs/deleted.spec.ts"));
      expect(
        selectE2eSpecs(["apps/web/e2e/specs/deleted.spec.ts"], root),
      ).toEqual(listE2eSpecs(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("follows named and star re-exports, indexes and literal dynamic imports", () => {
  const { root, write } = fixture();
  try {
    for (const contents of [
      'export { onlyA } from "./only-a";',
      'export * from "./only-a";',
      'export const load = () => import("./only-a");',
    ]) {
      write("apps/web/e2e/helpers/index.ts", contents);
      write("apps/web/e2e/specs/a.spec.ts", 'import "../helpers";');
      expect(selectE2eSpecs(["apps/web/e2e/helpers/only-a.ts"], root)).toEqual([
        "apps/web/e2e/specs/a.spec.ts",
      ]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deleted helper imported by unchanged specs selects every shard", () => {
  const { root } = fixture();
  try {
    rmSync(path.join(root, "apps/web/e2e/helpers/only-a.ts"));
    rmSync(path.join(root, "apps/web/e2e/specs/b.spec.ts"));
    expect(
      selectedE2ePlan(["apps/web/e2e/helpers/only-a.ts"], root).matrix.shard,
    ).toEqual(allE2eMatrix().shard);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  'import "../helpers/missing";',
  'const name = "../helpers/shared"; void import(name);',
  `const name = "shared"; void import(\`../helpers/\${name}\`);`,
  'void import(/* computed */ ("../helpers/" + "shared"));',
  "void require(globalThis.HELPER);",
  'import { readFileSync } from "node:fs"; readFileSync("fixture.json");',
  "export {",
])("an unclassifiable graph selects every shard: %s", (contents) => {
  const { root, write } = fixture();
  try {
    write("apps/web/e2e/specs/a.spec.ts", contents);
    expect(selectedE2ePlan(["apps/web/e2e/helpers/shared.ts"], root)).toEqual({
      status: "full",
      matrix: allE2eMatrix(),
      specs: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an e2e runner input no spec imports selects every shard", () => {
  const { root, write } = fixture();
  try {
    write(
      "apps/web/e2e/playwright.config.ts",
      'export default { testDir: "./specs" };\n',
    );
    write("apps/web/e2e/global-setup.ts", "export default () => {};\n");
    expect(
      selectedE2ePlan(["apps/web/e2e/playwright.config.ts"], root).matrix.shard,
    ).toEqual(allE2eMatrix().shard);
    expect(
      selectedE2ePlan(["apps/web/e2e/global-setup.ts"], root).matrix.shard,
    ).toEqual(allE2eMatrix().shard);
    expect(
      selectedE2ePlan(["apps/web/e2e/helpers/only-a.ts"], root).matrix.shard,
    ).toEqual([1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["globalSetup", "globalTeardown"] as const)(
  "%s importing a helper used by a spec selects every shard",
  (hook) => {
    const { root, write } = fixture();
    try {
      const hookFile =
        hook === "globalSetup" ? "global-setup.ts" : "global-teardown.ts";
      write(
        "apps/web/e2e/playwright.config.ts",
        `export default { testDir: "./specs", ${hook}: "./${hookFile}" };\n`,
      );
      write(`apps/web/e2e/${hookFile}`, 'import "./helpers/only-a";\n');
      expect(selectedE2ePlan(["apps/web/e2e/helpers/only-a.ts"], root)).toEqual(
        {
          status: "full",
          matrix: allE2eMatrix(),
          specs: [],
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a transitive global hook import outside e2e selects every shard", () => {
  const { root, write } = fixture();
  try {
    write(
      "apps/web/e2e/playwright.config.ts",
      'export default { testDir: "./specs", globalSetup: "./global-setup.ts" };\n',
    );
    write("apps/web/e2e/global-setup.ts", 'import "../hooks/shared";\n');
    write("apps/web/hooks/shared.ts", 'import "../e2e/helpers/only-a";\n');
    expect(selectedE2ePlan(["apps/web/e2e/helpers/only-a.ts"], root)).toEqual({
      status: "full",
      matrix: allE2eMatrix(),
      specs: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a config import used by specs selects every shard when changed", () => {
  const { root, write } = fixture();
  try {
    write(
      "apps/web/e2e/playwright.config.ts",
      'import { shared } from "./helpers/shared";\nexport default { testDir: "./specs", use: { shared } };\n',
    );
    expect(selectedE2ePlan(["apps/web/e2e/helpers/shared.ts"], root)).toEqual({
      status: "full",
      matrix: allE2eMatrix(),
      specs: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["missing", "unreadable"] as const)(
  "a %s Playwright config selects every shard",
  (configState) => {
    const { root } = fixture();
    try {
      const config = path.join(root, "apps/web/e2e/playwright.config.ts");
      if (configState === "missing") {
        rmSync(config);
      } else {
        rmSync(config);
        mkdirSync(config);
      }
      expect(selectedE2ePlan(["apps/web/e2e/helpers/only-a.ts"], root)).toEqual(
        {
          status: "full",
          matrix: allE2eMatrix(),
          specs: [],
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a computed global hook configuration selects every shard", () => {
  const { root, write } = fixture();
  try {
    write(
      "apps/web/e2e/playwright.config.ts",
      'const hook = globalThis.e2eHookPath;\nexport default { testDir: "./specs", globalSetup: hook };\n',
    );
    expect(selectedE2ePlan(["apps/web/e2e/helpers/only-a.ts"], root)).toEqual({
      status: "full",
      matrix: allE2eMatrix(),
      specs: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  '"**/*.setup.ts"',
  '"prepare.setup.ts"',
  "/\\.setup\\.ts$/",
  '["prepare.setup.ts", /\\.setup\\.ts$/]',
])("a setup project dependency selects every shard: %s", (testMatch) => {
  const { root, write } = fixture();
  try {
    write(
      "apps/web/e2e/playwright.config.ts",
      `export default {
  testDir: "./specs",
  projects: [
    { name: "setup", testMatch: ${testMatch} },
    { name: "browser", dependencies: ["setup"], testMatch: "**/*.spec.ts" },
  ],
};\n`,
    );
    write(
      "apps/web/e2e/specs/prepare.setup.ts",
      'import "../helpers/only-a";\n',
    );
    expect(selectedE2ePlan(["apps/web/e2e/helpers/only-a.ts"], root)).toEqual({
      status: "full",
      matrix: allE2eMatrix(),
      specs: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a network baseline input schedules the dedicated leg", () => {
  const { root, write } = fixture();
  try {
    write("apps/web/e2e/network-budgets/change.json", "{}\n");
    expect(
      selectedE2ePlan(["apps/web/e2e/network-budgets/change.json"], root).matrix
        .shard,
    ).toContain("network-baseline");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a route-smoke-only PR runs only the dedicated network leg", () => {
  const { root, write } = fixture();
  try {
    const spec = "apps/web/e2e/specs/route-smoke.spec.ts";
    write(spec);
    expect(selectedE2ePlan([spec], root)).toEqual({
      status: "selected",
      matrix: { shard: ["network-baseline"] },
      specs: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
