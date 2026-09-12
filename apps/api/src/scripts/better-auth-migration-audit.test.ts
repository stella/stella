import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseBetterAuthAuditArgs,
  persistBetterAuthAuditBaseline,
  readBetterAuthAuditBaseline,
  readBetterAuthTrustedIdentityMap,
} from "@/api/scripts/better-auth-migration-audit";
import {
  AUTH_TABLE_AUDIT_POLICY,
  AUTH_BASELINE_MODEL_NAMES,
  BETTER_AUTH_AUDIT_CHECKS,
  BETTER_AUTH_AUDIT_MODES,
  parseBetterAuthAuditBaseline,
  parseBetterAuthTrustedIdentityMap,
  renderBetterAuthAuditReport,
} from "@/api/scripts/better-auth-migration-audit.logic";
import type { BetterAuthAuditReport } from "@/api/scripts/better-auth-migration-audit.logic";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map(
      async (directory) => await rm(directory, { recursive: true }),
    ),
  );
});

const baselinePayload = () => ({
  accountIdentityProjection: {
    digest: "d".repeat(64),
    rowCount: "7",
  },
  accessPolicyDigest: "c".repeat(64),
  formatVersion: 4,
  oauthPolicyProjection: {
    clientCount: "3",
    digest: "e".repeat(64),
    resourceCount: "3",
  },
  tables: Object.fromEntries(
    AUTH_BASELINE_MODEL_NAMES.map((model) => [
      model,
      {
        preservedColumns: [...AUTH_TABLE_AUDIT_POLICY[model].preservedColumns],
        primaryKeyDigest: "a".repeat(64),
        rowContentDigest: "b".repeat(64),
        rowCount: "7",
      },
    ]),
  ),
});

const identityMapPayload = () =>
  ({
    formatVersion: 1,
    microsoftAccounts: [
      {
        accountId: "71c02436-6600-42fd-84d0-417484a177b0",
        accountRowId: "account-row-1",
        issuer:
          "https://login.microsoftonline.com/3a893563-0d4e-4309-9a31-b6e4e9f64479/v2.0",
        legacyAccountId: "legacy-subject",
      },
    ],
  }) as const;

describe("Better Auth migration audit command", () => {
  test("requires an identity map before migration and only a baseline after it", () => {
    expect(
      parseBetterAuthAuditArgs([
        BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
        "--baseline",
        "/private/baseline.json",
        "--identity-map",
        "/private/identity-map.json",
        "--oauth-base-url",
        "https://api.stll.app",
      ]),
    ).toMatchObject({
      status: "ok",
      value: {
        baselinePath: "/private/baseline.json",
        identityMapPath: "/private/identity-map.json",
        mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
        oauthBaseUrl: "https://api.stll.app",
      },
    });
    expect(
      parseBetterAuthAuditArgs([
        BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
        "--baseline",
        "/private/baseline.json",
        "--oauth-base-url",
        "https://api.stll.app/",
      ]).status,
    ).toBe("ok");
    for (const args of [
      [],
      [BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION],
      ["unknown", "--baseline", "/private/baseline.json"],
      [BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION, "--output", "x"],
      [BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION, "--baseline", ""],
      [
        BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
        "--baseline",
        "x",
        "--identity-map",
        "",
      ],
      [BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION, "--baseline", "x", "extra"],
      [
        BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
        "--baseline",
        "x",
        "--oauth-base-url",
        "http://api.stll.app",
      ],
      [
        BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
        "--baseline",
        "x",
        "--oauth-base-url",
        "https://api.stll.app/auth",
      ],
    ]) {
      expect(parseBetterAuthAuditArgs(args).status).toBe("error");
    }
  });

  test("rejects incomplete, expanded, or malformed private baselines", () => {
    expect(parseBetterAuthAuditBaseline(baselinePayload()).status).toBe("ok");
    expect(
      parseBetterAuthAuditBaseline({ formatVersion: 4, tables: {} }).status,
    ).toBe("error");
    const expanded = baselinePayload();
    expanded.tables["unreviewedAuthTable"] = {
      preservedColumns: ["id"],
      primaryKeyDigest: "a".repeat(64),
      rowContentDigest: "b".repeat(64),
      rowCount: "0",
    };
    expect(parseBetterAuthAuditBaseline(expanded).status).toBe("error");
    const malformed = baselinePayload();
    const first = Object.values(malformed.tables).at(0);
    if (first) {
      first.primaryKeyDigest = "not-a-digest";
    }
    expect(parseBetterAuthAuditBaseline(malformed).status).toBe("error");

    const unknownColumn = baselinePayload();
    const unknownColumnTable = Object.values(unknownColumn.tables).at(0);
    if (unknownColumnTable) {
      unknownColumnTable.preservedColumns.push("unreviewed_column");
    }
    expect(parseBetterAuthAuditBaseline(unknownColumn).status).toBe("error");

    const duplicateColumn = baselinePayload();
    const duplicateColumnTable = Object.values(duplicateColumn.tables).at(0);
    const duplicated = duplicateColumnTable?.preservedColumns.at(0);
    if (duplicateColumnTable && duplicated) {
      duplicateColumnTable.preservedColumns.push(duplicated);
    }
    expect(parseBetterAuthAuditBaseline(duplicateColumn).status).toBe("error");
  });

  test("accepts only canonical, unique Microsoft identity mappings", () => {
    const mapping = identityMapPayload();

    expect(parseBetterAuthTrustedIdentityMap(mapping).status).toBe("ok");
    expect(
      parseBetterAuthTrustedIdentityMap({
        ...mapping,
        microsoftAccounts: [
          ...mapping.microsoftAccounts,
          mapping.microsoftAccounts[0],
        ],
      }).status,
    ).toBe("error");
    expect(
      parseBetterAuthTrustedIdentityMap({
        ...mapping,
        microsoftAccounts: [
          { ...mapping.microsoftAccounts[0], accountId: "not-an-oid" },
        ],
      }).status,
    ).toBe("error");
  });

  test("reads the trusted map only from a private regular file", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "stella-better-auth-identity-map-"),
    );
    temporaryDirectories.push(directory);
    const mapPath = path.join(directory, "identity-map.json");
    await writeFile(mapPath, JSON.stringify(identityMapPayload()), {
      mode: 0o600,
    });
    expect((await readBetterAuthTrustedIdentityMap(mapPath)).status).toBe("ok");

    await chmod(mapPath, 0o644);
    expect((await readBetterAuthTrustedIdentityMap(mapPath)).status).toBe(
      "error",
    );
    await chmod(mapPath, 0o600);
    const linkedPath = path.join(directory, "linked-identity-map.json");
    await symlink(mapPath, linkedPath);
    expect((await readBetterAuthTrustedIdentityMap(linkedPath)).status).toBe(
      "error",
    );
  });

  test("creates the baseline once, accepts an identical rerun, and refuses replacement", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "stella-better-auth-audit-"),
    );
    temporaryDirectories.push(directory);
    const baselinePath = path.join(directory, "baseline.json");
    const parsed = parseBetterAuthAuditBaseline(baselinePayload());
    expect(parsed.status).toBe("ok");
    if (parsed.status === "error") {
      return;
    }

    expect(
      (await persistBetterAuthAuditBaseline(baselinePath, parsed.value)).status,
    ).toBe("ok");
    expect(
      (await persistBetterAuthAuditBaseline(baselinePath, parsed.value)).status,
    ).toBe("ok");
    expect((await readBetterAuthAuditBaseline(baselinePath)).status).toBe("ok");

    const changedPayload = baselinePayload();
    const first = Object.values(changedPayload.tables).at(0);
    if (first) {
      first.rowCount = "8";
    }
    const changed = parseBetterAuthAuditBaseline(changedPayload);
    expect(changed.status).toBe("ok");
    if (changed.status === "ok") {
      const conflict = await persistBetterAuthAuditBaseline(
        baselinePath,
        changed.value,
      );
      expect(conflict).toMatchObject({
        error: { code: "baseline-conflict" },
        status: "error",
      });
    }

    await chmod(baselinePath, 0o644);
    expect((await readBetterAuthAuditBaseline(baselinePath)).status).toBe(
      "error",
    );
    await chmod(baselinePath, 0o600);
    const linkedPath = path.join(directory, "linked-baseline.json");
    await symlink(baselinePath, linkedPath);
    expect((await readBetterAuthAuditBaseline(linkedPath)).status).toBe(
      "error",
    );
  });

  test("renders only stable names and statuses", () => {
    const report = {
      checks: [
        {
          name: BETTER_AUTH_AUDIT_CHECKS.AUTH_ROWS_PRESERVED,
          status: "failed",
        },
      ],
      mode: BETTER_AUTH_AUDIT_MODES.POST_MIGRATION,
      status: "failed",
    } as const satisfies BetterAuthAuditReport;
    const rendered = renderBetterAuthAuditReport(report);

    expect(JSON.parse(rendered)).toEqual(report);
    for (const forbidden of [
      "person@example.invalid",
      "client-secret-sentinel",
      "token-sentinel",
      "postgres://database.invalid",
      "primary-key-digest-sentinel",
      '"rowCount"',
    ]) {
      expect(rendered).not.toContain(forbidden);
    }
  });
});
