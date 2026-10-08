import { afterEach, expect, mock, test } from "bun:test";

import { createDevErrorLogger } from "./dev-error";
import { QUERY_ERROR_OUTPUT_FIELDS } from "./query-field-policy";

const consoleError = console.error;

afterEach(() => {
  console.error = consoleError;
});

test("no-ops outside dev", () => {
  const spy = mock(() => undefined);
  console.error = spy;
  const sink = mock(() => undefined);
  const log = createDevErrorLogger({ echoErrors: false, sink });

  log(new Error("boom"), { requestId: "r1" });

  expect(spy).not.toHaveBeenCalled();
  expect(sink).not.toHaveBeenCalled();
});

test("echoes to console and forwards to the sink in dev", () => {
  const spy = mock(() => undefined);
  console.error = spy;
  const sink = mock(() => undefined);
  const log = createDevErrorLogger({ echoErrors: true, sink });
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
  const log = createDevErrorLogger({ echoErrors: true });

  log(new Error("boom"));

  expect(spy).toHaveBeenCalledTimes(1);
});

test("dev sinks drop every shared query field from context", () => {
  const fields = Object.fromEntries(
    QUERY_ERROR_OUTPUT_FIELDS.flatMap((key) => [
      [key, "fixture-query-value"],
      [key.toUpperCase(), "fixture-query-value"],
      [`database.${key.split("").join("_")}`, "fixture-query-value"],
    ]),
  );
  const sink = mock(() => undefined);
  const log = createDevErrorLogger({ echoErrors: true, sink });
  console.error = mock(() => undefined);
  const error = new Error("fixture error");
  log(error, { requestId: "fixture-request", ...fields, nested: fields });
  expect(sink).toHaveBeenCalledWith({
    error: expect.objectContaining({
      message: "Error caused by database query failure",
    }),
    context: { requestId: "fixture-request", nested: {} },
  });
});
