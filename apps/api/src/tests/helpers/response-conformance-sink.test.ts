import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { ResponseConformanceError } from "@/api/lib/response-conformance-error";

import {
  captureResponseConformanceViolations,
  recordResponseConformanceViolation,
} from "./response-conformance-sink";

const violation = (route: string) =>
  new ResponseConformanceError({
    route,
    status: 200,
    issuePath: "/value",
    message: "fixture body must not appear in lifecycle diagnostics",
  });

test("explicit captures retain async context and isolate overlapping operations", async () => {
  const leftGate = Promise.withResolvers<undefined>();
  const rightGate = Promise.withResolvers<undefined>();
  const leftViolation = violation("GET /left");
  const rightViolation = violation("GET /right");
  const left = captureResponseConformanceViolations(async () => {
    recordResponseConformanceViolation({ cause: leftViolation });
    await leftGate.promise;
    recordResponseConformanceViolation(leftViolation);
    return { side: "left" };
  });
  const right = captureResponseConformanceViolations(async () => {
    await rightGate.promise;
    recordResponseConformanceViolation(rightViolation);
    return 42;
  });
  rightGate.resolve(undefined);
  expect(await right).toEqual({ value: 42, violations: [rightViolation] });
  leftGate.resolve(undefined);
  expect(await left).toEqual({
    value: { side: "left" },
    violations: [leftViolation],
  });
});

test("explicit capture propagates callback failures", async () => {
  const failure = new TypeError("capture callback failed");
  expect(
    await rejectionOf(
      captureResponseConformanceViolations(async () => {
        recordResponseConformanceViolation(violation("GET /expected-failure"));
        throw failure;
      }),
    ),
  ).toBe(failure);
});

test("pure lifecycle hooks retain and drain typed defects without importing the test runner", async () => {
  const sinkModule = new URL("response-conformance-sink.ts", import.meta.url)
    .href;
  const errorModule = new URL(
    "../../lib/response-conformance-error.ts",
    import.meta.url,
  ).href;
  const fixture = `
import assert from "node:assert/strict";
const { ResponseConformanceError } = await import(${JSON.stringify(errorModule)});
const { recordResponseConformanceViolation: record, captureResponseConformanceViolations: capture, installResponseConformanceTestHooks: install, ResponseConformanceTestError } = await import(${JSON.stringify(sinkModule)});
const defect = new ResponseConformanceError({ route: "GET /fixture", status: 200, issuePath: "/value", message: "fixture body must not appear in lifecycle diagnostics" });
record(defect);
const hooks = { beforeEach: [], afterEach: [], afterAll: [] };
install({ beforeEach: hook => hooks.beforeEach.push(hook), afterEach: hook => hooks.afterEach.push(hook), afterAll: hook => hooks.afterAll.push(hook) });
assert.deepEqual(Object.values(hooks).map(list => list.length), [1, 1, 1]);
const before = hooks.beforeEach[0], after = hooks.afterEach[0], all = hooks.afterAll[0];
before(); after();
const bodyDefect = new ResponseConformanceError({ route: "GET /body", status: 200, issuePath: "(body)", contentType: "text/plain", message: "fixture body must not appear in lifecycle diagnostics" });
before(); record(bodyDefect);
assert.throws(after, error => {
  assert(error instanceof ResponseConformanceTestError);
  assert(error.message.includes("content-type: text/plain"));
  assert.equal(error.violations[0].contentType, "text/plain");
  assert(!JSON.stringify(error).includes("fixture body"));
  return true;
});
record({ cause: { cause: defect } });
before();
record(defect);
record(new TypeError("unrelated failure"));
const cycle = {}; cycle.cause = cycle; record(cycle);
assert.throws(after, error => {
  assert(error instanceof ResponseConformanceTestError);
  assert.deepEqual(error.violations, [{ route: "GET /fixture", status: 200, issuePath: "/value" }]);
  assert.equal(error.message, "Response conformance failed: GET /fixture status 200 at /value");
  assert(!JSON.stringify(error).includes("fixture body"));
  return true;
});
before(); after();
let release;
const gate = new Promise(resolve => { release = resolve; });
let detached;
const captured = await capture(() => {
  detached = gate.then(() => record(defect));
  return "captured";
});
assert.deepEqual(captured, { value: "captured", violations: [] });
release(); await detached;
before(); assert.throws(after, ResponseConformanceTestError);
before(); after();
record(defect);
assert.throws(all, ResponseConformanceTestError);
all();
before();
assert.throws(before, /require serial tests/);
assert.throws(after, /require serial tests/);
assert.throws(all, /require serial tests/);
`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", fixture], {
    cwd: new URL("../../../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
});
