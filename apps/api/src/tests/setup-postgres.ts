import "./setup-env";

// Migrations leave pristine OAuth initialization to server startup. Gated
// suites call auth directly, so initialize before any fixture creates users.
const { assertConfiguredBetterAuthOAuthPolicy } =
  await import("../lib/db/assert-better-auth-oauth-policy");
await assertConfiguredBetterAuthOAuthPolicy();
