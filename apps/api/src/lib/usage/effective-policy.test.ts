/**
 * Organization limits read through one owner: the `organization_effective_policy`
 * database function (with `organization_member_capacity` and
 * `organization_storage_capacity` on top). A direct read of a policy's limit
 * columns would bypass entitlement status and the free floor, so this guard
 * enumerates every production source file and refuses one outside the
 * allowlist. The allowlist only shrinks; each entry names its reason.
 */

import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

const API_ROOT = nodePath.resolve(import.meta.dir, "../../..");

const LIMIT_COLUMN_READ =
  /usagePolicies\.(?:maxMembers|storageBytesPerAssignment)\b|\busage_policies\b[^;]*\b(?:max_members|storage_bytes_per_assignment)\b|\b(?:max_members|storage_bytes_per_assignment)\b[^;]*\busage_policies\b/su;

const ALLOWED_LIMIT_COLUMN_READS = {
  "src/db/schema/usage.ts": "declares the columns and their checks",
  "src/handlers/usage/create-hosted-setup.ts":
    "reads the capacity a plan would grant at checkout, before any entitlement exists",
} as const satisfies Record<string, string>;

const readsLimitColumns = (source: string): boolean =>
  LIMIT_COLUMN_READ.test(source);

const productionSources = async (): Promise<string[]> => {
  const files: string[] = [];
  for await (const file of new Bun.Glob("src/**/*.ts").scan({
    cwd: API_ROOT,
  })) {
    if (file.endsWith(".test.ts") || file.startsWith("src/tests/")) {
      continue;
    }
    files.push(file);
  }
  return files.toSorted();
};

describe("organization limits read through the effective-policy owner", () => {
  test("the detector recognizes direct and raw limit-column reads", () => {
    expect(
      readsLimitColumns(
        "db.select({ cap: usagePolicies.storageBytesPerAssignment })",
      ),
    ).toBe(true);
    expect(
      readsLimitColumns(
        "select p.max_members from usage_policies p where p.id = $1",
      ),
    ).toBe(true);
    expect(
      readsLimitColumns(
        "select ep.max_members from organization_effective_policy($1) ep",
      ),
    ).toBe(false);
  });

  test("only allowlisted production files read a policy's limit columns", async () => {
    const readers: string[] = [];
    for (const file of await productionSources()) {
      if (
        readsLimitColumns(await Bun.file(nodePath.join(API_ROOT, file)).text())
      ) {
        readers.push(file);
      }
    }
    expect(readers).toEqual(Object.keys(ALLOWED_LIMIT_COLUMN_READS).toSorted());
  });
});
