import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { OWNERSHIP } from "../../scripts/ownership.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

// `member-call` rows are scoped by path, which the passive fixture under
// `.oxlint-plugins/__fixtures__` cannot sit inside, so they are exercised here
// with a source written beneath the scoped prefix.
const MEMBER_CALL_OPTIONS = {
  entries: [
    {
      id: "deterministic-job-requeue",
      owner: ["apps/api/src/lib/bullmq-requeue.ts"],
      enforcement: {
        kind: "member-call",
        method: "getState",
        within: ["apps/api/src/"],
        allowed: [{ path: "apps/api/src/lib/allowed.ts", reason: "test" }],
      },
    },
  ],
};

const SOURCE = [
  "const state = await job.getState();",
  "const optional = await job?.getState();",
  "const other = await job.getStatus();",
  "const read = job.getState;",
  "",
].join("\n");

const lint = async (sourcePath: string) =>
  await lintSingleRule("confine-owner", SOURCE, {
    ruleOptions: MEMBER_CALL_OPTIONS,
    sourcePath,
  });

describe.serial("confine-owner member-call rows", () => {
  test("reports a call of the method inside the scoped paths", async () => {
    expect(await lint("apps/api/src/lib/sweep.ts")).toEqual([1, 2]);
  });

  test("leaves the owner and its allowed files alone", async () => {
    expect(await lint("apps/api/src/lib/bullmq-requeue.ts")).toEqual([]);
    expect(await lint("apps/api/src/lib/allowed.ts")).toEqual([]);
  });

  test("leaves files outside the scoped paths alone", async () => {
    expect(await lint("apps/web/src/store.ts")).toEqual([]);
  });
});

const storedContentEntries = OWNERSHIP.filter(({ id }) =>
  [
    "stored-file-read",
    "stored-tenant-file-read",
    "audited-download-grant",
    "content-delivery-intent",
    "content-delivery-receipt",
    "content-delivery-scope",
  ].includes(id),
);

describe.serial("confine-owner stored content rows", () => {
  test("covers each stored content owner", () => {
    expect(storedContentEntries.map(({ id }) => id)).toEqual([
      "stored-file-read",
      "stored-tenant-file-read",
      "audited-download-grant",
      "content-delivery-intent",
      "content-delivery-receipt",
      "content-delivery-scope",
    ]);
  });

  for (const entry of storedContentEntries) {
    test(`${entry.id} confines each binding through static and dynamic module access`, async () => {
      if (entry.enforcement.kind !== "import") {
        throw new TypeError("Stored content ownership must confine imports.");
      }
      const module = entry.enforcement.specifiers.at(0);
      const names = entry.enforcement.names;
      const ownerPath = entry.owner.at(0);
      if (
        module === undefined ||
        names === undefined ||
        names.length === 0 ||
        ownerPath === undefined
      ) {
        throw new TypeError(
          "Stored content ownership must name a module, bindings, and owner.",
        );
      }
      const sources = [
        `import * as owned from "${module}";`,
        `export * from "${module}";`,
        `const module = await import("${module}");`,
      ];
      for (const name of names) {
        sources.push(
          `import { ${name} as import_${name} } from "${module}";`,
          `export { ${name} as export_${name} } from "${module}";`,
          `const { ${name}: destructured_${name} } = await import("${module}");`,
          `const member_${name} = (await import("${module}")).${name};`,
        );
      }
      const source = sources.join("\n");
      const ruleOptions = { entries: [entry] };
      expect(
        await lintSingleRule("confine-owner", source, { ruleOptions }),
      ).toEqual(sources.map((_, index) => index + 1));
      expect(
        await lintSingleRule("confine-owner", source, {
          ruleOptions,
          sourcePath: ownerPath,
        }),
      ).toEqual([]);
    });
  }
});
