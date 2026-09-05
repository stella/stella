// Passive regression fixture for
// `no-internal-module-mock/no-internal-module-mock`.

const captureTarget = "@/api/lib/analytics/capture";

// MUST flag: a workspace alias names one of this repository's own modules,
// so the fabricated factory replaces a contract the test should exercise.
// Written above the import on purpose: imports are hoisted, so source order
// must not hide the binding.
// oxlint-disable-next-line no-internal-module-mock/no-internal-module-mock -- fixture: workspace alias target, call precedes its import
void mock.module("@/api/lib/analytics/capture", () => ({
  capture: () => "captured",
}));

// oxlint-disable-next-line import/first -- fixture: the import deliberately follows its first use
import { mock as bunMock, mock } from "bun:test";

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

// MUST flag: the TanStack AI engine is a runtime, not a boundary; the fake
// hands the code under test chunks the real `chat()` never emits.
// oxlint-disable-next-line no-internal-module-mock/no-internal-module-mock -- fixture: runtime engine target
void mock.module("@tanstack/ai", () => ({ chat: () => "fabricated" }));

// MUST flag: an adapter package maps provider events onto the engine's, so a
// fabricated mapping fabricates the same shape.
// oxlint-disable-next-line no-internal-module-mock/no-internal-module-mock -- fixture: runtime engine adapter target
void mock.module("@tanstack/ai-openai", () => ({}));

// Allowed: an npm package is an external boundary.
void mock.module("bullmq", () => ({ Queue: "fake-queue" }));

// Allowed: a runtime builtin.
void mock.module("node:child_process", () => ({ spawn: () => "spawned" }));

// Allowed: an unrelated `module` method on a different receiver.
const registry = { module: (name: string): string => name };
registry.module("@/api/lib/s3");
