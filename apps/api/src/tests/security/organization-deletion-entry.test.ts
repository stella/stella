import { describe, expect, test } from "bun:test";
import path from "node:path";

const apiRoot = path.resolve(import.meta.dir, "../../..");

// Deleting an organization cascades its audit trail, so every deletion has to
// pass the audit archive precondition. The precondition lives inside the one
// function that deletes the organization row, and these censuses keep it the
// only one: a second deletion path would have to change them on purpose.
const ORGANIZATION_ROW_DELETE =
  /\.delete\(\s*organization\s*\)|DELETE\s+FROM\s+(?:public\.)?"?organization"?\b|\bdeleteOrganization\s*\(/iu;
const ALLOWED_ROW_DELETERS = ["src/lib/organization-storage-teardown.ts"];

const DELETION_OWNER_CALL = /\bcompleteOrganizationDeletion\s*\(/u;
const ALLOWED_OWNER_CALLERS = ["src/lib/auth.ts"];

const isTestSource = (relativePath: string) =>
  relativePath.includes(".test.") ||
  relativePath.startsWith("src/tests/") ||
  relativePath.includes("/__fixtures__/");

const productionSources = async function* () {
  const glob = new Bun.Glob("{src,scripts}/**/*.{ts,tsx}");
  for await (const relativePath of glob.scan({ cwd: apiRoot })) {
    if (isTestSource(relativePath)) {
      continue;
    }
    yield {
      relativePath,
      source: await Bun.file(path.join(apiRoot, relativePath)).text(),
    };
  }
};

describe("organization deletion entry points", () => {
  test("only the deletion owner deletes an organization row", async () => {
    const deleters: string[] = [];
    for await (const { relativePath, source } of productionSources()) {
      if (ORGANIZATION_ROW_DELETE.test(source)) {
        deleters.push(relativePath);
      }
    }
    expect(deleters.toSorted()).toEqual(ALLOWED_ROW_DELETERS);
  });

  test("the organization plugin's delete hook is the deletion owner's only caller", async () => {
    const callers: string[] = [];
    for await (const { relativePath, source } of productionSources()) {
      // The owner's own definition names it without calling it.
      const calls = source.replaceAll(
        /export const completeOrganizationDeletion\s*=/gu,
        "",
      );
      if (DELETION_OWNER_CALL.test(calls)) {
        callers.push(relativePath);
      }
    }
    expect(callers.toSorted()).toEqual(ALLOWED_OWNER_CALLERS);
  });

  test("only the deletion owner grants the organization delete guard", async () => {
    // The database refuses every organization row delete that its
    // transaction did not name in this setting (migration
    // 20261101090100_organization_delete_owner_guard); this census keeps the
    // setting in the owner's hands.
    const granters: string[] = [];
    for await (const { relativePath, source } of productionSources()) {
      if (
        /\bSETTING_ORGANIZATION_DELETION_IDS\b|app\.organization_deletion_ids/u.test(
          source,
        )
      ) {
        granters.push(relativePath);
      }
    }
    expect(granters.toSorted()).toEqual([
      "src/db/rls.ts",
      "src/lib/organization-storage-teardown.ts",
    ]);
  });

  test("the owner requires the audit archive before it writes anything", async () => {
    const source = await Bun.file(
      path.join(apiRoot, "src/lib/organization-storage-teardown.ts"),
    ).text();
    const owner = source.indexOf("export const completeOrganizationDeletion");
    const gate = source.indexOf("requireOrganizationAuditExport(", owner);
    const refusal = source.indexOf('auditExport.type === "refused"', gate);
    const teardown = source.indexOf(
      "recordOrganizationStorageTeardown(",
      owner,
    );
    const rowDelete = source.indexOf("delete(organization)", owner);

    expect(owner).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(owner);
    expect(refusal).toBeGreaterThan(gate);
    expect(teardown).toBeGreaterThan(refusal);
    expect(rowDelete).toBeGreaterThan(teardown);
  });
});
