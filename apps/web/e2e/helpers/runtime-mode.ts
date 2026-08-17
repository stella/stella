// Local e2e runs target the Vite dev server; production CI opts out
// explicitly (E2E_EXPECT_DEV_ROUTES=false) so the same specs prove that
// dev-only routes and dev-only diagnostics cannot leak into the built app.
export const EXPECTS_DEV_RUNTIME =
  process.env["E2E_EXPECT_DEV_ROUTES"] !== "false";
