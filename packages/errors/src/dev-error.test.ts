import { afterEach, expect, mock, test } from "bun:test";

import { createDevErrorLogger } from "./dev-error";

const consoleError = console.error;

afterEach(() => {
  console.error = consoleError;
});

test("no-ops outside dev", () => {
  const spy = mock(() => undefined);
  console.error = spy;
  const sink = mock(() => undefined);
  const log = createDevErrorLogger({ isDev: false, sink });

  log(new Error("boom"), { requestId: "r1" });

  expect(spy).not.toHaveBeenCalled();
  expect(sink).not.toHaveBeenCalled();
});

test("echoes to console and forwards to the sink in dev", () => {
  const spy = mock(() => undefined);
  console.error = spy;
  const sink = mock(() => undefined);
  const log = createDevErrorLogger({ isDev: true, sink });
  const error = new Error("boom");

  log(error, { requestId: "r1" });

  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith(error);
  expect(sink).toHaveBeenCalledTimes(1);
  expect(sink).toHaveBeenCalledWith({ error, context: { requestId: "r1" } });
});

test("works without a sink", () => {
  const spy = mock(() => undefined);
  console.error = spy;
  const log = createDevErrorLogger({ isDev: true });

  log(new Error("boom"));

  expect(spy).toHaveBeenCalledTimes(1);
});
