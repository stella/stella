import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  QUERY_PERF_PROFILES,
  queryPerfDatabaseName,
} from "../src/tests/query-perf/profiles";
import {
  fixtureConnectionEnvironment,
  queryPerfSnapshotKey,
  QueryPerfSnapshotError,
} from "./query-perf-snapshot";

describe("query performance snapshot boundaries", () => {
  test("accepts only the dedicated loopback fixture without libpq query overrides", () => {
    for (const profileId of QUERY_PERF_PROFILES) {
      const databaseName = queryPerfDatabaseName(profileId);
      for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
        expect(
          fixtureConnectionEnvironment(
            `postgres://fixture:secret@${host}:5439/${databaseName}`,
            profileId,
          ).PGDATABASE,
        ).toBe(databaseName);
      }
    }
    for (const expectedProfile of QUERY_PERF_PROFILES) {
      for (const actualProfile of QUERY_PERF_PROFILES) {
        if (expectedProfile === actualProfile) {
          continue;
        }
        expect(() =>
          fixtureConnectionEnvironment(
            `postgres://localhost/${queryPerfDatabaseName(actualProfile)}`,
            expectedProfile,
          ),
        ).toThrow(QueryPerfSnapshotError);
      }
    }
    for (const profileId of QUERY_PERF_PROFILES) {
      const databaseName = queryPerfDatabaseName(profileId);
      for (const url of [
        `postgres://fixture:secret@db.example/${databaseName}`,
        "postgres://localhost/stella",
        `postgres://localhost/${databaseName}?host=db.example`,
        `postgres://localhost/${databaseName}?service=production`,
        `postgres://localhost/${databaseName}#ignored`,
        `https://localhost/${databaseName}`,
      ]) {
        expect(() => fixtureConnectionEnvironment(url, profileId)).toThrow(
          QueryPerfSnapshotError,
        );
      }
    }
    expect(
      fixtureConnectionEnvironment(
        `postgres://fixture:p%40ss@127.0.0.1/${queryPerfDatabaseName("small")}`,
        "small",
      ).PGPASSWORD,
    ).toBe("p@ss");
  });

  test("cache identity changes for every migration, synthetic input, planner setting and PostgreSQL major", () => {
    const root = mkdtempSync(path.join(tmpdir(), "query-perf-key-"));
    const inputs = [
      "package.json",
      "bun.lock",
      "apps/api/drizzle/meta/journal.json",
      "apps/api/drizzle/0000.sql",
      "apps/api/src/tests/query-perf/synthetic/seed.ts",
      "apps/api/src/tests/query-perf/synthetic/profile.json",
      "apps/api/scripts/query-perf-snapshot.ts",
      "apps/api/scripts/test-db-snapshot-cache.ts",
      "settings.json",
    ];
    try {
      for (const input of inputs) {
        mkdirSync(path.dirname(path.join(root, input)), { recursive: true });
        writeFileSync(path.join(root, input), "");
      }
      const options = {
        repositoryRoot: root,
        seedEntry: "apps/api/src/tests/query-perf/synthetic/seed.ts",
        settingsFile: "settings.json",
        pgMajor: 18,
        profileId: "small",
      } as const satisfies Parameters<typeof queryPerfSnapshotKey>[0];
      const original = queryPerfSnapshotKey(options);
      expect(queryPerfSnapshotKey(options)).toBe(original);
      for (const input of inputs) {
        writeFileSync(path.join(root, input), "// changed");
        expect(queryPerfSnapshotKey(options)).not.toBe(original);
        writeFileSync(path.join(root, input), "");
        expect(queryPerfSnapshotKey(options)).toBe(original);
      }
      expect(queryPerfSnapshotKey({ ...options, pgMajor: 19 })).not.toBe(
        original,
      );
      expect(
        queryPerfSnapshotKey({ ...options, profileId: "growth" }),
      ).not.toBe(original);
      writeFileSync(path.join(root, "apps/api/drizzle/new.sql"), "SELECT 1;");
      expect(queryPerfSnapshotKey(options)).not.toBe(original);
      rmSync(path.join(root, "apps/api/drizzle/new.sql"));
      writeFileSync(
        path.join(root, "apps/api/src/tests/query-perf/synthetic/new.json"),
        "{}",
      );
      expect(queryPerfSnapshotKey(options)).not.toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
