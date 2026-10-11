import { expect, test } from "bun:test";
import path from "node:path";

import {
  typecheckOwnershipIssues,
  validateApiTypecheckProjects,
} from "./api-typecheck-projects";

test("every API TypeScript source has exactly one compiler project owner", () => {
  expect(
    validateApiTypecheckProjects(path.resolve(import.meta.dir, "../../..")),
  ).toEqual([]);
});

test("missing and overlapping project roots fail ownership validation", () => {
  const sources = ["src/a.ts", "src/a.test.ts", "scripts/new.ts"];
  const projects = [
    { project: "src", files: ["src/a.ts"] },
    { project: "tests", files: ["src/a.test.ts"] },
  ];
  expect(
    typecheckOwnershipIssues(sources, projects).map(({ path: file }) => file),
  ).toEqual(["scripts/new.ts"]);
  expect(
    typecheckOwnershipIssues(sources.slice(0, 2), [
      ...projects,
      { project: "extra", files: ["src/a.test.ts"] },
    ]).map(({ path: file }) => file),
  ).toEqual(["src/a.test.ts"]);
});
