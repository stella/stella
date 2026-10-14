import { expect, test } from "bun:test";

const source = await Bun.file(
  new URL("dev-quick-start-button.tsx", import.meta.url),
).text();

test("quick start accepts a three-matter LAB import without polling for completion", () => {
  expect(source).toContain("const QUICK_START_MATTER_COUNT = 3;");
  expect(source).toContain('api.dev["seed-firm-knowledge"].post');
  expect(source).not.toContain('api.dev["seed-firm-knowledge"].get');
});

test("quick start accepts the professional-use statement right after sign-in", () => {
  const signIn = source.indexOf("authClient.signIn.emailOtp(");
  const accept = source.indexOf('api.me["professional-use"].post(');
  const importStart = source.indexOf('api.dev["seed-firm-knowledge"].post');
  expect(signIn).toBeGreaterThan(-1);
  expect(accept).toBeGreaterThan(signIn);
  // The API refuses every signed-in request of an account that has not
  // accepted the statement, so acceptance precedes the import.
  expect(importStart).toBeGreaterThan(accept);
  expect(source).toContain(
    "statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION",
  );
});
