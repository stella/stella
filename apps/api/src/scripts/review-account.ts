/**
 * Usage:
 *   bun /app/review-account.js provision
 *   bun /app/review-account.js set-password      # password on standard input
 *
 * `provision` creates, idempotently, the restricted review account named by
 * APP_REVIEW_ACCOUNT_EMAIL, the organization APP_REVIEW_ORGANIZATION_ID, and
 * the account's single owner membership. `set-password` reads one line from
 * standard input (never an argument or the environment), stores it through
 * Better Auth's password hashing, and ends the account's browser sessions;
 * OAuth grants stay. Only fixed outcome words and counts are printed.
 */
import { createOwnerReviewAccountOrganizationStore } from "@/api/db/root";
import { env } from "@/api/env";
import { getAuth } from "@/api/lib/auth";
import {
  bindReviewAccountOrganizationStore,
  createReviewAccountAuthStore,
  runReviewAccountCommand,
} from "@/api/scripts/review-account.logic";
import type { ReviewAccountStore } from "@/api/scripts/review-account.logic";

const createStore = async (): Promise<ReviewAccountStore> => ({
  ...createReviewAccountAuthStore(await getAuth().$context),
  ...bindReviewAccountOrganizationStore(
    await createOwnerReviewAccountOrganizationStore(),
  ),
});

const readStdin = (): AsyncIterable<Uint8Array> => {
  // On a terminal, raw mode keeps the typed password from being echoed.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stderr.write("Password: ");
  }
  return process.stdin;
};

const exitCode = await runReviewAccountCommand({
  argv: process.argv.slice(2),
  config: {
    email: env.APP_REVIEW_ACCOUNT_EMAIL,
    organizationId: env.APP_REVIEW_ORGANIZATION_ID,
  },
  demoEmail: env.DEMO_ACCOUNT_EMAIL,
  io: {
    stdin: readStdin,
    writeOut: (line) => {
      process.stdout.write(`${line}\n`);
    },
    writeErr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  },
  store: createStore,
});
if (process.stdin.isTTY) {
  process.stdin.setRawMode(false);
  process.stderr.write("\n");
}
process.exit(exitCode);
