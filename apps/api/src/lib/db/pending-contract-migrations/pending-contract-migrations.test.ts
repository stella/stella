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
const DAY_MS = 86_400_000;

describe("pending contract migrations", () => {
  test("every contract SQL file is registered and every entry has its file", () => {
    const files = readdirSync(PENDING_CONTRACT_MIGRATIONS_DIR)
      .filter((entry) => entry.endsWith(".sql"))
      .toSorted();
    expect(files).toEqual(
      PENDING_CONTRACT_MIGRATIONS.map(({ name }) => `${name}.sql`).toSorted(),
    );
  });

  test("no entry has passed its deadline", () => {
    for (const migration of PENDING_CONTRACT_MIGRATIONS) {
      const lastInstant = Date.parse(`${migration.expiresAt}T00:00:00.000Z`);
      expect(Number.isFinite(lastInstant)).toBe(true);
      // The rollout window for older readers has ended: ship the contract
      // step as a migration under drizzle/ and delete the entry, or renew the
      // deadline with the reason in the review.
      expect(Date.now()).toBeLessThan(lastInstant + DAY_MS);
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
});
