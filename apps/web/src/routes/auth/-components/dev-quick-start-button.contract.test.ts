import { expect, test } from "bun:test";

const source = await Bun.file(
  new URL("dev-quick-start-button.tsx", import.meta.url),
).text();

test("quick start accepts a three-matter LAB import without polling for completion", () => {
  expect(source).toContain("const QUICK_START_MATTER_COUNT = 3;");
  expect(source).toContain('api.dev["seed-firm-knowledge"].post');
  expect(source).not.toContain('api.dev["seed-firm-knowledge"].get');
});

test("quick start accepts the professional-use statement before its first signed-in request", () => {
  const accept = source.indexOf('api.me["professional-use"].post(');
  const orgStep = source.indexOf(
    "const createOrganization = async (identity: DevQuickStartIdentity) => {\n  // Runs after both sign-in paths, before the first signed-in API request.\n  await acceptProfessionalUse();",
  );
  const importStart = source.indexOf('api.dev["seed-firm-knowledge"].post');
  expect(accept).toBeGreaterThan(-1);
  // The organization step runs after password and two-factor sign-in alike.
  expect(orgStep).toBeGreaterThan(-1);
  // The API refuses every signed-in request of an account that has not
  // accepted the statement, so acceptance precedes the import.
  expect(importStart).toBeGreaterThan(orgStep);
  expect(source).toContain(
    "statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION",
  );
});

test("quick-start failures show the server's reason, not a fixed text", () => {
  expect(source).not.toContain("? ERROR_MESSAGES[result.error.code]");
  expect(source.split("? result.error.message").length - 1).toBe(2);
});
