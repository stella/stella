import { BASELINE_PATHS } from "./baseline-paths";

export const SHARED_LEDGER_PATHS = [
  ".oxlint-plugins/no-hand-rolled-concurrency-exceptions.json",
  ".oxlint-plugins/require-audit-on-mutation-ledger.json",
  "apps/api/capability-description-ledger.json",
  "apps/api/src/mcp/write-tool-authority-ledger.json",
  "apps/api/src/tests/export-dropping-mock-ledger.json",
  "apps/api/src/tests/security/public-response-text-bounds.allowlist.json",
  "packages/property-testing/property-seeds.json",
  "scripts/app-boundary-exceptions.json",
  "scripts/calendar-day-ledger.json",
  "scripts/chat-fixture-guard-ledger.json",
  "scripts/contract-domain-ledger.json",
  "scripts/dead-columns.allowlist.json",
  "scripts/fill-diagnostics-ledger.json",
  "scripts/internal-module-mock-ledger.json",
  "scripts/offline-check-exceptions.json",
  "scripts/parser-validator-call-ledger.json",
  "scripts/projection-totality.allowlist.json",
  "scripts/sha256-migration-ledger.json",
  "scripts/suppression-waivers.json",
  "scripts/swallowed-item-error-ledger.json",
] as const;

export const ORDER_MEANINGFUL_JSON = {
  "apps/api/src/tests/fixtures/provider-request-schemas/chat-prompt-baseline.json":
    "Prompt prefix order is the provider-cache contract.",
  "apps/api/src/lib/db/migration-alias-inventory.json":
    "Migration chronology determines alias application order.",
  "packages/cli/src/generated/registry-snapshot.json":
    "Generated registry presentation order is part of the snapshot.",
  "packages/cli/src/generated/resources-snapshot.json":
    "Generated resource presentation order is part of the snapshot.",
} as const satisfies Record<string, string>;

export const CANONICAL_JSON_PATHS = [
  ...Object.values(BASELINE_PATHS).filter(
    (file) => !(file in ORDER_MEANINGFUL_JSON),
  ),
  ...SHARED_LEDGER_PATHS,
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const canonicalJsonOrderError = (value: unknown): string | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  const ids = value.flatMap((entry) =>
    isRecord(entry) && typeof entry["id"] === "string" ? [entry["id"]] : [],
  );
  if (ids.length !== value.length) {
    return null;
  }
  if (
    ids.some((id, index) => {
      const previous = ids.at(index - 1);
      return index > 0 && previous !== undefined && previous >= id;
    })
  ) {
    return "array entries must be sorted and duplicate-free by id";
  }
  return null;
};
