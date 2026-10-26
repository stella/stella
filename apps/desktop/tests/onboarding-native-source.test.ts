import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src-tauri/src/onboarding.rs", import.meta.url),
  "utf-8",
);

test("the shortcut cannot advance before Try it has been shown", () => {
  expect(source).toContain(
    "input == Input::ShortcutPressed && onboarding.shown != Some(Step::TryIt)",
  );
});

test("the pending check does not keep a temporary state handle alive", () => {
  expect(source).toContain("let state = app.state::<OnboardingState>();");
  expect(source).toContain("let pending = state\n    .lock()");
});
