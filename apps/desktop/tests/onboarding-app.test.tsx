import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/onboarding/OnboardingApp.tsx", import.meta.url),
  "utf-8",
);

test("snapshot reads and advances share one operation queue", () => {
  expect(source).toContain("operations.current.then(operation)");
  expect(source).toContain("void enqueue(refreshUnlessDisposed)");
  expect(source).toMatch(
    /await enqueue\(async \(\) => \{[\s\S]*onboarding_advance/u,
  );
  expect(source).not.toContain("requestId");
});
