import { expect, test } from "bun:test";

import exceptions from "../.oxlint-plugins/no-hand-rolled-concurrency-exceptions.json" with { type: "json" };
import { concurrencyExceptionChanges } from "./check-concurrency-exceptions";

test("concurrency exception identities can only shrink", () => {
  expect(concurrencyExceptionChanges(exceptions, exceptions)).toEqual([]);
  expect(concurrencyExceptionChanges(exceptions.slice(1), exceptions)).toEqual(
    [],
  );
  const entry = exceptions.at(0);
  expect(entry).toBeDefined();
  if (entry === undefined) {
    return;
  }
  expect(
    concurrencyExceptionChanges(
      [{ ...entry, path: "apps/other/sleep.ts" }],
      exceptions,
    ),
  ).toHaveLength(1);
  expect(
    concurrencyExceptionChanges(
      [{ ...entry, source: "setTimeout(resolve, arbitraryDelay)" }],
      exceptions,
    ),
  ).toHaveLength(1);
  expect(concurrencyExceptionChanges([entry, entry], exceptions)).toHaveLength(
    1,
  );
  expect(
    concurrencyExceptionChanges([{ ...entry, reason: " " }], exceptions),
  ).toHaveLength(1);
});
