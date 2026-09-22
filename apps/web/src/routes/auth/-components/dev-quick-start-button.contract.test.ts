import { expect, test } from "bun:test";

const source = await Bun.file(
  new URL("dev-quick-start-button.tsx", import.meta.url),
).text();

test("quick start accepts a three-matter LAB import without polling for completion", () => {
  expect(source).toContain("const QUICK_START_MATTER_COUNT = 3;");
  expect(source).toContain('api.dev["seed-firm-knowledge"].post');
  expect(source).not.toContain('api.dev["seed-firm-knowledge"].get');
});
