import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { toSafeId } from "@/api/lib/branded-types";

/**
 * Organization-scoped machine-key lifecycle.
 *
 * The bug these cover is one the feature shipped with and that a caller-scoped
 * read reintroduces silently: the plugin's own `getApiKey`/`updateApiKey` scope
 * to `referenceId === session.user.id`, so an org admin could not revoke a key
 * a colleague minted. A machine credential nobody can revoke when its creator
 * leaves — or when it leaks — defeats the point of having lifecycle management,
 * and nothing about it looks broken until the day you need it.
 */

const findOrganizationMachineApiKey = mock();
const updateApiKey = mock();

void mock.module("@/api/lib/machine-api-key-queries", () => ({
  findOrganizationMachineApiKey,
  listOrganizationMachineApiKeys: mock(),
}));

void mock.module("@/api/lib/auth", () => ({
  getAuth: () => ({ api: { updateApiKey } }),
  resolveMemberAuthorization: mock(),
}));

const { disableMachineApiKey, loadOrganizationMachineApiKey } =
  await import("@/api/handlers/api-keys/mint");

const ORG_ID = toSafeId<"organization">("org-acme");
const ADMIN_A = "user-admin-a";
const ADMIN_B = "user-admin-b";
const KEY_ID = "key-minted-by-b";

const keyRow = (overrides: Record<string, unknown> = {}) => ({
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  enabled: true,
  expiresAt: null,
  id: KEY_ID,
  lastRequest: null,
  metadata: JSON.stringify({
    organizationId: ORG_ID,
    scopes: ["stella:read"],
  }),
  name: "ci-deploy",
  permissions: JSON.stringify({ workspace: ["read"] }),
  referenceId: ADMIN_B,
  start: "stella_mk_abc",
  ...overrides,
});

describe("organization-scoped machine key lifecycle", () => {
  test("an admin can load a key minted by a different member of the same organization", async () => {
    // The case that was broken: admin A acting on admin B's key. The lookup is
    // scoped by organization, so B's key resolves for A.
    findOrganizationMachineApiKey.mockResolvedValue(keyRow());

    const loaded = await loadOrganizationMachineApiKey({
      keyId: KEY_ID,
      organizationId: ORG_ID,
    });

    expect(loaded.isOk()).toBe(true);
    if (loaded.isOk()) {
      expect(loaded.value.ownerUserId).toBe(ADMIN_B);
    }
  });

  test("the lookup is scoped by organization id, never by the calling user", async () => {
    // If this ever starts passing a user id, caller-scoping has crept back in.
    findOrganizationMachineApiKey.mockClear();
    findOrganizationMachineApiKey.mockResolvedValue(keyRow());

    await loadOrganizationMachineApiKey({
      keyId: KEY_ID,
      organizationId: ORG_ID,
    });

    expect(findOrganizationMachineApiKey).toHaveBeenCalledWith({
      keyId: KEY_ID,
      organizationId: ORG_ID,
    });
  });

  test("revoking another member's key tells the plugin the OWNER, not the caller", async () => {
    // The plugin enforces `referenceId === body.userId` on the server-side path.
    // Passing the caller would make a colleague's key unrevokable; passing the
    // owner satisfies the plugin while our own org check does the real gating.
    updateApiKey.mockClear();
    updateApiKey.mockResolvedValue({});

    const revoked = await disableMachineApiKey({
      keyId: KEY_ID,
      ownerUserId: ADMIN_B,
    });

    expect(revoked.isOk()).toBe(true);
    const call = updateApiKey.mock.calls[0]?.[0];
    expect(call?.body?.userId).toBe(ADMIN_B);
    expect(call?.body?.enabled).toBe(false);
    // The acting admin must not appear anywhere in the call: if the caller's id
    // reaches the plugin, the plugin scopes to them and B's key stops being
    // revokable by A.
    expect(JSON.stringify(call)).not.toContain(ADMIN_A);
  });

  test("the revoke call sends no headers, or the plugin would re-impose caller scoping", async () => {
    // With headers present the plugin resolves the principal from the session
    // and ignores `body.userId`, which is exactly the behaviour that made
    // cross-member revocation impossible.
    updateApiKey.mockClear();
    updateApiKey.mockResolvedValue({});

    await disableMachineApiKey({ keyId: KEY_ID, ownerUserId: ADMIN_B });

    expect(updateApiKey.mock.calls[0]?.[0]?.headers).toBeUndefined();
  });

  test("a key in a different organization is not found, and reports 404 rather than 403", async () => {
    // The org predicate runs in SQL, so a foreign key simply does not come back.
    // 404 over 403 keeps id probing from confirming that a key exists elsewhere.
    findOrganizationMachineApiKey.mockResolvedValue(null);

    const loaded = await loadOrganizationMachineApiKey({
      keyId: "key-in-another-org",
      organizationId: ORG_ID,
    });

    expect(loaded.isErr()).toBe(true);
    if (loaded.isErr()) {
      expect(loaded.error.status).toBe(404);
    }
  });

  test("a row whose metadata does not parse is treated as absent, not rendered", async () => {
    findOrganizationMachineApiKey.mockResolvedValue(
      keyRow({ metadata: "not-json" }),
    );

    const loaded = await loadOrganizationMachineApiKey({
      keyId: KEY_ID,
      organizationId: ORG_ID,
    });

    expect(loaded.isErr()).toBe(true);
  });
});

/**
 * Structural guard on the tenant boundary itself.
 *
 * The behavioural tests above mock the query module, so they prove how callers
 * use the lookup but not that the lookup is actually scoped. `apikey` denies the
 * scoped `stella` role, so these reads run on the owner connection with no RLS
 * behind them: the SQL predicate is the only thing separating organizations.
 * This asserts the predicate is present in the query builder and that no
 * handler re-implements it in JS, which is the shape a regression would take.
 *
 * This is a source-level check, not an executed-SQL check — it cannot prove the
 * predicate is correct, only that it exists where it must.
 */
describe("machine key tenant filter", () => {
  const handlersDir = path.resolve(import.meta.dir, "../../handlers/api-keys");
  const readHandler = (file: string) =>
    readFileSync(path.join(handlersDir, file), "utf-8");

  // Owner-level DB access lives in `lib`, not beside the handlers: handlers are
  // barred from importing `rootDb`, so the queries that read this table
  // unmediated by RLS sit in one narrow, reviewable helper.
  const readQueryHelper = () =>
    readFileSync(
      path.resolve(import.meta.dir, "../../lib/machine-api-key-queries.ts"),
      "utf-8",
    );

  // The predicate itself lives in its own leaf module so the membership
  // revocation path can apply the identical scope without pulling in the
  // owner-level connection. One definition, two callers.
  const readScopeHelper = () =>
    readFileSync(
      path.resolve(import.meta.dir, "../../lib/machine-api-key-scope.ts"),
      "utf-8",
    );

  test("every exported query applies the organization predicate in SQL", () => {
    const source = readQueryHelper();

    // Both exported readers must route through `organizationScope`.
    const exportedQueries = [
      "listOrganizationMachineApiKeys",
      "findOrganizationMachineApiKey",
    ];
    for (const name of exportedQueries) {
      expect(source).toContain(name);
    }
    expect(source).toContain("organizationScope(organizationId)");
  });

  test("the shared scope predicate filters on config id and metadata organization", () => {
    const source = readScopeHelper();

    expect(source).toContain("MACHINE_API_KEY_CONFIG_ID");
    expect(source).toContain("'organizationId'");
  });

  test("member removal revokes machine keys through that same predicate", () => {
    // The gap this closes: without it a removed member's keys survive as live
    // rows and start working again the moment they are re-invited. Scoping by
    // the owner alone would reach into organizations they have not left, so
    // both halves have to be here.
    const source = readFileSync(
      path.resolve(import.meta.dir, "../../lib/auth-artifacts.ts"),
      "utf-8",
    );

    expect(source).toContain("machineApiKeyOrganizationScope(organizationId)");
    expect(source).toContain("eq(apikey.referenceId, userId)");
    // Disabled, not deleted: the audit trail and `start` prefix have to survive.
    expect(source).toContain("update(apikey)");
    expect(source).toContain("enabled: false");
    expect(source).not.toContain("delete(apikey)");
  });

  test("no handler filters by organization id in JS after the query", () => {
    // A post-filter means the database already returned another tenant's rows.
    // `list.ts` may drop undescribable rows, but never on organization id.
    for (const file of ["list.ts", "rotate.ts", "revoke.ts", "create.ts"]) {
      const source = readHandler(file);
      expect(source).not.toContain(
        "organizationId !== session.activeOrganizationId",
      );
      expect(source).not.toContain(
        "metadata.output.organizationId !== organizationId",
      );
    }
  });

  test("rotate refuses an already-revoked key before minting a replacement", () => {
    // A rotate racing (or retried after) a revoke would otherwise mint a fresh
    // active key carrying the revoked key's scopes, undoing the revocation. The
    // enabled guard must sit before the mint call, not after it.
    const source = readHandler("rotate.ts");
    const guardAt = source.indexOf("!existing.enabled");
    // The invocation, matched with its leading newline+indent, so the
    // top-of-file import of the same name does not count as "before".
    const mintCallAt = source.indexOf("\n      mintMachineApiKey({");
    expect(guardAt).toBeGreaterThan(-1);
    expect(mintCallAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(mintCallAt);
  });
});

describe("machine key permission parsing", () => {
  test("a resource named after a prototype key is unknown, not a 500", async () => {
    // `STATEMENT_ACTIONS["constructor"]` resolves to a prototype value under a
    // plain index read; calling `.includes` on it throws. The parser must
    // return the unknown-resource result instead.
    const { parseMachineApiKeyPermissions } =
      await import("@/api/lib/machine-api-key-config");
    for (const key of ["constructor", "__proto__", "toString"]) {
      const parsed = parseMachineApiKeyPermissions({ [key]: ["read"] });
      expect(parsed.type).toBe("unknown-resource");
    }
  });
});
