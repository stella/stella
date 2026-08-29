// Passive regression fixture for
// `no-internal-module-mock/no-internal-module-mock`.

import { mock as bunMock, mock } from "bun:test";

const captureTarget = "@/api/lib/analytics/capture";

// MUST flag: a workspace alias names one of this repository's own modules,
// so the fabricated factory replaces a contract the test should exercise.
// oxlint-disable-next-line no-internal-module-mock/no-internal-module-mock -- fixture: workspace alias target
void mock.module("@/api/lib/analytics/capture", () => ({
  capture: () => "captured",
}));

// MUST flag: a relative specifier is a workspace module too.
// oxlint-disable-next-line no-internal-module-mock/no-internal-module-mock -- fixture: relative target
void mock.module("./browser-open.js", () => ({ openBrowser: () => "opened" }));

// MUST flag: a workspace package scope.
// oxlint-disable-next-line no-internal-module-mock/no-internal-module-mock -- fixture: workspace package target
void mock.module("@stll/errors", () => ({}));

// MUST flag: the aliased binding is the same `bun:test` mock registry.
// oxlint-disable-next-line no-internal-module-mock/no-internal-module-mock -- fixture: aliased mock binding
void bunMock.module("../env.js", () => ({ readEnv: () => ({}) }));

// MUST flag: a computed specifier cannot be classified.
// oxlint-disable-next-line no-internal-module-mock/no-internal-module-mock -- fixture: non-literal target
void mock.module(captureTarget, () => ({}));

// Allowed: an npm package is an external boundary.
void mock.module("bullmq", () => ({ Queue: "fake-queue" }));

// Allowed: a runtime builtin.
void mock.module("node:child_process", () => ({ spawn: () => "spawned" }));

// Allowed: an unrelated `module` method on a different receiver.
const registry = { module: (name: string): string => name };
registry.module("@/api/lib/s3");
