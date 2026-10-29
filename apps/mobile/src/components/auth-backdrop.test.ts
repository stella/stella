import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { AUTH_GRADIENT_END, AUTH_GRADIENT_START } from "./auth-backdrop";

const WEB_AUTH_LAYOUT = readFileSync(
  path.join(import.meta.dir, "../../../web/src/routes/auth/route.tsx"),
  "utf-8",
);

describe("the sign-in backdrop", () => {
  test("ends in the web sign-in's blue in both schemes", () => {
    expect(WEB_AUTH_LAYOUT).toContain(
      `:root { --auth-gradient-end: ${AUTH_GRADIENT_END.light}; }`,
    );
    expect(WEB_AUTH_LAYOUT).toContain(
      `.dark { --auth-gradient-end: ${AUTH_GRADIENT_END.dark}; }`,
    );
  });

  test("starts turning where the web's does", () => {
    expect(WEB_AUTH_LAYOUT).toContain(
      `var(--background) ${AUTH_GRADIENT_START * 100}%`,
    );
  });
});
