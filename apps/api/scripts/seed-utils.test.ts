import { afterEach, expect, test } from "bun:test";

import { MARKETING_LOCALE_ACCOUNTS } from "@stll/playwright-tools/marketing-locales";

import { globalSeedId, seedId } from "./seed-utils";

const previousNamespace = Bun.env["STELLA_SEED_ID_NAMESPACE"];
const previousOrgId = Bun.env["STELLA_SEED_ORG_ID"];

afterEach(() => {
  if (previousNamespace === undefined) {
    delete Bun.env["STELLA_SEED_ID_NAMESPACE"];
  } else {
    Bun.env["STELLA_SEED_ID_NAMESPACE"] = previousNamespace;
  }
  if (previousOrgId === undefined) {
    delete Bun.env["STELLA_SEED_ORG_ID"];
  } else {
    Bun.env["STELLA_SEED_ORG_ID"] = previousOrgId;
  }
});

// A locale firm's run resolves the shared corpus the primary run wrote, so a
// shared row's id must not move with the run's namespace.
test("a shared row's id is the same from every organization's run", () => {
  delete Bun.env["STELLA_SEED_ID_NAMESPACE"];
  delete Bun.env["STELLA_SEED_ORG_ID"];
  const primary = globalSeedId("case-law-source-cz-ns");
  expect(primary).toBe(seedId("case-law-source-cz-ns"));

  Bun.env["STELLA_SEED_ORG_ID"] = MARKETING_LOCALE_ACCOUNTS.cs.organizationId;
  expect(globalSeedId("case-law-source-cz-ns")).toBe(primary);
  expect(seedId("case-law-source-cz-ns")).not.toBe(primary);

  Bun.env["STELLA_SEED_ID_NAMESPACE"] = "org:test-org-stella-dev-sk";
  expect(globalSeedId("case-law-source-cz-ns")).toBe(primary);
});
