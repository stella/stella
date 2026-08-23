import { expect, test } from "bun:test";

import { formatLogDetail } from "./log-detail";

// The shape Bun rejects a timed-out `fetch` with: a DOMException carrying
// a name and a message, and a stack that is the EMPTY STRING rather than
// absent. Constructing one directly leaves `stack` undefined, so the empty
// stack is set here to model what the runtime actually hands the logger.
const timeoutError = (): Error => {
  const error = new DOMException("The operation timed out.", "TimeoutError");
  error.stack = "";
  return error;
};

test("the fixture models an empty stack, not an absent one", () => {
  // A fixture with an absent stack would exercise the nullish branch and
  // pass under the defect this file exists to pin.
  expect(timeoutError().stack).toBe("");
});

test("renders an error whose stack is empty rather than absent", () => {
  expect(formatLogDetail(timeoutError())).toBe(
    "TimeoutError: The operation timed out.",
  );
});

test("renders a cause whose stack is empty rather than absent", () => {
  const wrapper = new Error("corpus index ingest failed", {
    cause: timeoutError(),
  });
  wrapper.stack = "Error: corpus index ingest failed\n    at ingest";

  expect(formatLogDetail(wrapper)).toBe(
    "Error: corpus index ingest failed\n    at ingest\n[cause] TimeoutError: The operation timed out.",
  );
});

test("prefers a stack when the error has one", () => {
  const error = new Error("boom");
  error.stack = "Error: boom\n    at somewhere";

  expect(formatLogDetail(error)).toBe("Error: boom\n    at somewhere");
});

test("omits the cause section when the cause is not an error", () => {
  const error = new Error("boom", { cause: "a string" });
  error.stack = "Error: boom";

  expect(formatLogDetail(error)).toBe("Error: boom");
});

test("passes a string detail through and serialises other values", () => {
  expect(formatLogDetail(undefined)).toBe("");
  expect(formatLogDetail("plain")).toBe("plain");
  expect(formatLogDetail({ adapterKey: "cz-us" })).toBe(
    '{"adapterKey":"cz-us"}',
  );
});

// `logError` drops a falsy detail, so returning anything but a string here
// loses the detail entirely — the same silent loss this module exists to
// stop. Both unserialisable shapes are covered: one throws, one does not.
test("names a detail it cannot serialise rather than returning nothing", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;

  expect(formatLogDetail(cyclic)).toBe("[unserializable log detail]");
  expect(formatLogDetail(() => "work")).toBe("[unserializable log detail]");
  expect(formatLogDetail(Symbol("adapter"))).toBe(
    "[unserializable log detail]",
  );
});
