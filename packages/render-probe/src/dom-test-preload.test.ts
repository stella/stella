import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { installDomTestStormGuard } from "./dom-test-guard";

// The preload settles each test from a hook it registers as the test starts,
// counting on Bun to run that hook before the test file's own afterEach
// hooks (where cleanup unmounts the tree). These hooks fail if Bun changes
// that order.
const guard = installDomTestStormGuard();
let settledBefore = 0;

beforeEach(() => {
  settledBefore = guard.settled();
});

afterEach(() => {
  expect(guard.settled()).toBe(settledBefore + 1);
});

test("a test is settled before the file's afterEach hooks run", () => {
  expect(guard.settled()).toBe(settledBefore);
});

describe("inside a describe block", () => {
  afterEach(() => {
    expect(guard.settled()).toBe(settledBefore + 1);
  });

  test("a test is settled before the block's afterEach hooks run", () => {
    expect(guard.settled()).toBe(settledBefore);
  });
});
