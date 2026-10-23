import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/onboarding/ConnectStep.tsx", import.meta.url),
  "utf-8",
);

test("waiting for browser sign-in does not disable another attempt", () => {
  expect(source).not.toMatch(/<Button\s+disabled=\{waiting\}/u);
  expect(source).toContain("setWaiting(true)");
});
