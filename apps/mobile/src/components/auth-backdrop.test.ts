import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { AUTH_GRADIENT_START } from "./auth-backdrop";

const WEB_STYLES = readFileSync(
  path.join(import.meta.dir, "../../../web/src/styles/app.css"),
  "utf-8",
);

describe("the sign-in backdrop", () => {
  test("ends in the shared sign-in theme colour", () => {
    expect(WEB_STYLES).toContain("var(--auth-gradient-end)");
  });

  test("starts turning where the web's does", () => {
    expect(WEB_STYLES).toContain(
      `var(--background) ${AUTH_GRADIENT_START * 100}%`,
    );
  });
});
