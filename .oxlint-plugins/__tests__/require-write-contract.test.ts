import { expect, test } from "bun:test";

import { SAFE_HANDLER_FACTORIES } from "../../apps/api/src/lib/safe-handler-factories.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

for (const [factory, { module, configArgument }] of Object.entries(
  SAFE_HANDLER_FACTORIES,
)) {
  const wrap = (config: string) =>
    configArgument === "options" ? `{ config: ${config} }` : config;
  test(`${factory} rejects missing contracts and Replace patch declarations`, async () => {
    expect(
      await lintSingleRule(
        "require-write-contract",
        `import { ${factory} as handler } from "${module}";
handler(${wrap('{ description: "Update tags" }')}, fn);
handler(${wrap('{ contract: "patch", description: "Replace tags" }')}, fn);`,
      ),
    ).toEqual([2, 3]);
  });
  test(`${factory} accepts patch and replace contracts at its config boundary`, async () => {
    expect(
      await lintSingleRule(
        "require-write-contract",
        `import { ${factory} as handler } from "${module}";
handler(${wrap('{ contract: "patch", description: "Update tags" }')}, fn);
handler(${wrap('{ contract: "replace", description: "Replace tags" }')}, fn);`,
      ),
    ).toEqual([]);
  });
}

test("resolves named configs, aliased imports and ordered spreads", async () => {
  expect(
    await lintSingleRule(
      "require-write-contract",
      `import { createSafeHandler as make } from "@/api/lib/api-handlers";
const base = { contract: "patch", description: "Replace tags" };
const config = { ...base, contract: "replace" } satisfies HandlerConfig;
make(config, fn);
make({ ...config, contract: "patch" }, fn);`,
    ),
  ).toEqual([5]);
});

test("accepts declared contracts and ignores unrelated and shadowed factories", async () => {
  expect(
    await lintSingleRule(
      "require-write-contract",
      `import * as handlers from "@/api/lib/api-handlers";
import { createSafeHandler } from "unrelated";
handlers.createSafeHandler({ contract: "replace", description: "Replace tags" }, fn);
handlers.createSafeHandler({ contract: "patch", description: "Update tags" }, fn);
createSafeHandler({}, fn);
function local(handlers) { handlers.createSafeHandler({}, fn); }`,
    ),
  ).toEqual([]);
});

test("opaque or overriding spreads cannot establish a literal contract", async () => {
  expect(
    await lintSingleRule(
      "require-write-contract",
      `import { createSafeHandler } from "@/api/lib/api-handlers";
const base = { contract: "patch" };
createSafeHandler({ ...base, contract: dynamic }, fn);
createSafeHandler({ ...base, ...dynamic }, fn);`,
    ),
  ).toEqual([3, 4]);
});

test("factory owners forward typed parameters while concrete configs stay checked", async () => {
  expect(
    await lintSingleRule(
      "require-write-contract",
      `import { createSafeUncheckedBoundedPublicHandler } from "@/api/lib/api-handlers";
const forward = <T extends PublicHandlerConfig>({ config }: { config: T }) => createSafeUncheckedBoundedPublicHandler(config, fn);
createSafeUncheckedBoundedPublicHandler({}, fn);`,
      {
        sourcePath:
          "apps/api/src/handlers/case-law/decisions/public-subject.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([3]);
});

test("forwarding outside factory owners cannot bypass literal contracts", async () => {
  expect(
    await lintSingleRule(
      "require-write-contract",
      `import { createSafeUncheckedBoundedPublicHandler } from "@/api/lib/api-handlers";
const forward = <T extends PublicHandlerConfig>({ config }: { config: T }) => createSafeUncheckedBoundedPublicHandler(config, fn);`,
    ),
  ).toEqual([2]);
});

test("conditional configs and spreads preserve a shared contract", async () => {
  expect(
    await lintSingleRule(
      "require-write-contract",
      `import { createSafeHandler } from "@/api/lib/api-handlers";
const base = { contract: "patch" };
createSafeHandler(flag ? base : { ...base, realtime }, fn);
createSafeHandler({ ...base, ...(flag ? {} : { realtime }) }, fn);
createSafeHandler(flag ? base : { contract: "replace" }, fn);
createSafeHandler({ ...base, ...(flag ? {} : { contract: "replace" }) }, fn);
createSafeHandler(flag ? base : { ...base, description: "Replace tags" }, fn);`,
    ),
  ).toEqual([5, 6, 7]);
});

test("local config factories expose literal contracts without trusting parameters", async () => {
  expect(
    await lintSingleRule(
      "require-write-contract",
      `import { createSafeHandler } from "@/api/lib/api-handlers";
const base = { contract: "patch" };
const configFor = (response) => ({ ...base, response });
createSafeHandler(configFor(schema), fn);
const opaque = (contract) => ({ contract });
createSafeHandler(opaque("patch"), fn);
const mislabeled = (response) => ({ ...base, response, description: "Replace tags" });
createSafeHandler(mislabeled(schema), fn);`,
    ),
  ).toEqual([6, 8]);
});
