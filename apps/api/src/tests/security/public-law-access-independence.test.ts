import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const apiRoot = path.resolve(import.meta.dir, "../../..");
const publicReadPatterns = [
  "src/handlers/legal-resolve/**/*.ts",
  "src/handlers/legislation/**/*.ts",
  "src/handlers/case-law/decisions/**/*.ts",
  "src/mcp/decision-reader-tools.ts",
  "src/mcp/legislation-tools.ts",
  "src/mcp/compat-law-tools.ts",
  "src/mcp/stella-tools.ts",
  "src/mcp/compat-tools.ts",
  "src/mcp/research-admin-tools.ts",
];
const files = publicReadPatterns
  .flatMap((pattern) => [
    ...new Bun.Glob(pattern).scanSync({ cwd: apiRoot, onlyFiles: true }),
  ])
  .filter((file) => !file.endsWith(".test.ts"));

const accessStateDependency =
  /\b(?:mayReadPublicLaw(?:ForOrganization)?|allowsLawRead|readOrganizationAccessSnapshot|readOrganizationActionState|resolveOrganizationAccess|organizationAccessStates|FEATURE_ORG_ACCESS_STATE)\b|["']@\/api\/lib\/usage\/organization-access(?:-snapshot|-state)?["']/u;

const dependsOnAccessState = (source: string) =>
  accessStateDependency.test(source);

test("every public-law content module is independent of organization standing", () => {
  expect(files).toContain("src/handlers/legal-resolve/admission.ts");
  expect(files).toContain("src/handlers/case-law/decisions/get.ts");
  expect(files).toContain("src/handlers/legislation/get.ts");
  for (const file of files) {
    expect(
      dependsOnAccessState(readFileSync(path.join(apiRoot, file), "utf-8")),
      file,
    ).toBe(false);
  }
});

test("the census detects an access-state read added to a public-law module", () => {
  const source = readFileSync(
    path.join(apiRoot, "src/handlers/legal-resolve/admission.ts"),
    "utf-8",
  );
  expect(dependsOnAccessState(source)).toBe(false);
  expect(
    dependsOnAccessState(
      `${source}\nawait mayReadPublicLawForOrganization(organizationId);`,
    ),
  ).toBe(true);
});
