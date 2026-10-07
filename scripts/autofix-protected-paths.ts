import { BASELINE_PATHS } from "./baseline-paths";

// Decision records are never autofix outputs, including when the PR changed them.
export const AUTOFIX_PROTECTED_PATHS = [
  ...Object.values(BASELINE_PATHS),
  "scripts/ratchet-baseline.json",
  "scripts/ratchet-allowances/**",
  ".changeset/**",
  ".oxlint-plugins/require-audit-on-mutation-ledger.json",
  "apps/api/capability-description-ledger.json",
  "apps/api/src/mcp/write-tool-authority-ledger.json",
  "apps/api/src/tests/export-dropping-mock-ledger.json",
  "apps/api/src/tests/security/public-response-text-bounds.allowlist.json",
  "scripts/chat-fixture-guard-ledger.json",
  "scripts/calendar-day-ledger.json",
  "scripts/contract-domain-ledger.json",
  "scripts/fill-diagnostics-ledger.json",
  "scripts/internal-module-mock-ledger.json",
  "scripts/parser-validator-call-ledger.json",
  "scripts/sha256-migration-ledger.json",
  "scripts/swallowed-item-error-ledger.json",
  "scripts/suppression-waivers.json",
  "scripts/migration-baseline.txt",
  "packages/docx-utils/scripts/office-fixture-metadata-allowlist.json",
  "scripts/dead-columns.allowlist.json",
  "scripts/instruction-references-allowlist.json",
  "scripts/projection-totality.allowlist.json",
] as const;

export const isAutofixProtectedPath = (file: string) =>
  AUTOFIX_PROTECTED_PATHS.some((pattern) => new Bun.Glob(pattern).match(file));

if (import.meta.main) {
  console.log(AUTOFIX_PROTECTED_PATHS.join("\n"));
}
