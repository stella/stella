import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import {
  PENDING_CONTRACT_MIGRATIONS,
  PENDING_CONTRACT_MIGRATIONS_DIR,
  pendingContractSqlPath,
} from "./registry";

const DRIZZLE_DIR = nodePath.resolve(
  PENDING_CONTRACT_MIGRATIONS_DIR,
  "../../../../drizzle",
);

describe("pending contract migrations", () => {
  test("every contract SQL file is registered and every entry has its file", () => {
    const files = readdirSync(PENDING_CONTRACT_MIGRATIONS_DIR)
      .filter((entry) => entry.endsWith(".sql"))
      .toSorted();
    expect(files).toEqual(
      PENDING_CONTRACT_MIGRATIONS.map(({ name }) => `${name}.sql`).toSorted(),
    );
  });

  test("every deadline is a valid YYYY-MM-DD date", () => {
    for (const migration of PENDING_CONTRACT_MIGRATIONS) {
      expect(migration.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(
        new Date(`${migration.expiresAt}T00:00:00.000Z`).toISOString(),
      ).toBe(`${migration.expiresAt}T00:00:00.000Z`);
    }
  });

  test("a shipped contract step is no longer pending", () => {
    for (const migration of PENDING_CONTRACT_MIGRATIONS) {
      expect(existsSync(nodePath.join(DRIZZLE_DIR, migration.name))).toBe(
        false,
      );
    }
  });

  test("each step names an applied predecessor and sorts after it", () => {
    for (const migration of PENDING_CONTRACT_MIGRATIONS) {
      const firstLine =
        readFileSync(pendingContractSqlPath(migration), "utf-8").split(
          "\n",
        )[0] ?? "";
      const required = /^-- requires: (\S+)$/u.exec(firstLine)?.[1];
      expect(required).toBeDefined();
      expect(existsSync(nodePath.join(DRIZZLE_DIR, required ?? "-"))).toBe(
        true,
      );
      expect(migration.name > (required ?? "")).toBe(true);
    }
  });

  test("OAuth current-state uniqueness remains contract-only", () => {
    const contract = PENDING_CONTRACT_MIGRATIONS.find(
      ({ name }) => name === "20261027070500_mcp_oauth_current_state_contract",
    );
    expect(contract).toBeDefined();
    const contractSql = readFileSync(
      pendingContractSqlPath(contract ?? PENDING_CONTRACT_MIGRATIONS[0]),
      "utf-8",
    );
    const expandSql = readFileSync(
      nodePath.join(
        DRIZZLE_DIR,
        "20261027070300_mcp_oauth_current_state",
        "migration.sql",
      ),
      "utf-8",
    );
    const uniqueIndex =
      'CREATE UNIQUE INDEX "mcp_oauth_state_org_connector_user_uidx"';

    expect(contractSql).toContain(uniqueIndex);
    expect(expandSql).not.toContain(uniqueIndex);
  });
});
