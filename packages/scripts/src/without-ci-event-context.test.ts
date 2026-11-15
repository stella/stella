import { expect, test } from "bun:test";

import {
  CI_EVENT_CONTEXT_ENV,
  withoutCiEventContext,
} from "./without-ci-event-context";

test("drops every event context variable and keeps the rest", () => {
  const env = {
    ...Object.fromEntries(CI_EVENT_CONTEXT_ENV.map((name) => [name, "x"])),
    PATH: "/bin",
    GITHUB_OUTPUT: "/tmp/output",
  };
  expect(withoutCiEventContext(env)).toEqual({
    PATH: "/bin",
    GITHUB_OUTPUT: "/tmp/output",
  });
});

test("a merge-group runner's context does not reach a spawned script", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      "console.log(process.env.GITHUB_EVENT_NAME ?? '')",
    ],
    {
      env: withoutCiEventContext({
        ...process.env,
        GITHUB_EVENT_NAME: "merge_group",
      }),
      stdout: "pipe",
    },
  );
  expect(new TextDecoder().decode(child.stdout).trim()).toBe("");
});
