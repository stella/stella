import { expect, test } from "bun:test";
import path from "node:path";

import { bunExecutable } from "@stll/scripts/src/bun-executable";

test.each([
  {
    optIn: "",
    message: "Feature access seeding requires local development access",
  },
  {
    optIn: "1",
    message: "STELLA_LOCAL_DEV=1 requires NODE_ENV=development or test",
  },
])(
  "feature access seeding refuses production with opt-in '$optIn'",
  async ({ optIn, message }) => {
    const apiRoot = path.resolve(import.meta.dirname, "..");
    const child = Bun.spawn(
      [bunExecutable(), "scripts/seed-e2e-feature-access.ts"],
      {
        cwd: apiRoot,
        env: {
          ...process.env,
          NODE_ENV: "production",
          STELLA_LOCAL_DEV: optIn,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(stderr).toContain(message);
  },
);
