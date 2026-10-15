import { expect, test } from "bun:test";

const source = await Bun.file(
  new URL("dev-quick-start-button.tsx", import.meta.url),
).text();

test("quick start accepts a three-matter LAB import without polling for completion", () => {
  expect(source).toContain("const QUICK_START_MATTER_COUNT = 3;");
  expect(source).toContain('api.dev["seed-firm-knowledge"].post');
  expect(source).not.toContain('api.dev["seed-firm-knowledge"].get');
});

test("quick start accepts the professional-use statement right before the import", () => {
  const importStep = source.indexOf("const startMatterImport = async (");
  const accept = source.indexOf("await acceptProfessionalUse();", importStep);
  const importStart = source.indexOf('api.dev["seed-firm-knowledge"].post');
  // The import step runs on fresh, two-factor and resumed attempts alike, and
  // the API refuses signed-in requests until the statement is accepted.
  expect(importStep).toBeGreaterThan(-1);
  expect(accept).toBeGreaterThan(importStep);
  expect(importStart).toBeGreaterThan(accept);
  expect(source.split("await acceptProfessionalUse();").length - 1).toBe(1);
  expect(source).toContain(
    "statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION",
  );
});

test("quick-start failures show the server's reason, not a fixed text", () => {
  expect(source).not.toContain("? ERROR_MESSAGES[result.error.code]");
  expect(source.split("? result.error.message").length - 1).toBe(2);
});
