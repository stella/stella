import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("TryItStep.tsx", import.meta.url), "utf-8");

test("restarting shortcut listeners resets transient keyboard state", () => {
  expect(source).toContain("setFocused(document.hasFocus())");
  expect(source).toMatch(
    /return \(\) => \{[\s\S]*setHeld\(\[\]\);[\s\S]*setFeedback\(\{ type: "idle" \}\)/u,
  );
});
