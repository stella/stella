import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "gated-test-database",
  capability: "Opening a database client in a test",
  owner: ["apps/api/src/tests/gated-test-database.ts"],
  summary:
    "The Postgres-gated suites run in one process, so a client a suite " +
    "leaves open holds its connections until the run ends, and enough of " +
    "them exhaust the server in an unrelated suite. The owner opens a " +
    "suite's database with its cleanup and closes it after that cleanup " +
    "even when it throws, and scopes a test's extra sessions to the test. " +
    "`confine-owner` does not lint tests, so the " +
    "`bun-test-hygiene/no-unmanaged-database-client` rule holds this row " +
    "instead.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
