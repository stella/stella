/**
 * Usage:
 *   bun src/scripts/better-auth-migration-audit.ts pre-migration --baseline <path> --identity-map <path> --oauth-base-url <https-origin>
 *   bun src/scripts/better-auth-migration-audit.ts <post-mode> --baseline <path> --oauth-base-url <https-origin>
 *
 * The command lives in better-auth-migration-audit-command.ts.
 */

import { runBetterAuthMigrationAuditCli } from "@/api/scripts/better-auth-migration-audit-command";

if (import.meta.main) {
  await runBetterAuthMigrationAuditCli(Bun.argv.slice(2));
}
