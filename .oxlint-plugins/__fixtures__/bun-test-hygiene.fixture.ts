// Passive regression fixture for `bun-test-hygiene`.
//
// Each `oxlint-disable-next-line` suppresses a case the rule MUST flag; if the
// rule regresses, the unused directive fails the fixture harness. A blank line
// separates each case description from a disabled-test case, because a
// comment directly above a `.skip` counts as its reason.

import * as bt from "bun:test";
import {
  describe,
  it,
  test as check,
  test,
  xdescribe,
  xit,
  xtest,
} from "bun:test";

declare const local: { only: (title: string, fn: () => void) => void };
declare const flag: string | undefined;
const noop = () => undefined;
const table = [[1], [2]];

// --- no-focused-tests ---

// named import
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests
test.only("focused test", noop);
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests
it.only("focused it", noop);
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests
describe.only("focused block", noop);
// computed member
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests, typescript/dot-notation -- the computed form is the case under test
test["only"]("computed focus", noop);
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests, typescript/dot-notation -- the computed form is the case under test
test[`only`]("computed template focus", noop);
// aliased import
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests
check.only("aliased focus", noop);
// namespace import
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests
bt.test.only("namespace focus", noop);
// chained after a modifier call, and before `.each`
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests
test.if(true).only("conditional focus", noop);
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests
test.only.each(table)("focused table %d", noop);
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests
test.concurrent.only("concurrent focus", noop);
// a local object that is not a test function
// expect-clean: bun-test-hygiene/no-focused-tests
local.only("not a test function", noop);
// expect-clean: bun-test-hygiene/no-focused-tests
test("plain test", noop);

// --- no-disabled-tests ---

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
test.skip("skipped test", noop);

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
it.todo("todo it");

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
describe.skip("skipped block", noop);

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
xtest("x-prefixed test", noop);

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
xit("x-prefixed it", noop);

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
xdescribe("x-prefixed block", noop);

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
bt.it.skip("namespace skip", noop);

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests, typescript/dot-notation -- the computed form is the case under test
check["todo"]("aliased computed todo");

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
test.skip.each(table)("skipped table %d", noop);

// Waits on the upstream parser fix; re-enable when it lands.
// expect-clean: bun-test-hygiene/no-disabled-tests
test.skip("skip with a reason above", noop);
// expect-clean: bun-test-hygiene/no-disabled-tests
test.todo("todo with a reason on the same line"); // needs a fixture corpus
// expect-clean: bun-test-hygiene/no-disabled-tests
test.skipIf(flag === "off")("conditional skip", noop);
// expect-clean: bun-test-hygiene/no-disabled-tests
test.todoIf(flag === "off")("conditional todo", noop);

// a disabled registration in a branch, beside the real one with its title
if (flag === undefined) {
  // expect-clean: bun-test-hygiene/no-disabled-tests, bun-test-hygiene/no-identical-title
  describe.skip("branch suite", noop);
} else {
  // expect-clean: bun-test-hygiene/no-disabled-tests, bun-test-hygiene/no-identical-title
  describe("branch suite", noop);
}

// a conditional expression arm
// expect-clean: bun-test-hygiene/no-disabled-tests
const _armed = flag ? test.skip("arm", noop) : undefined;

describe("block with a branch", () => {
  if (flag === undefined) {
    return;
  }

  // oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
  test.skip("inside a block, not a branch", noop);
});

// --- no-identical-title ---

describe("first block", () => {
  test("same title", noop);
  // oxlint-disable-next-line bun-test-hygiene/no-identical-title
  test("same title", noop);
  // oxlint-disable-next-line bun-test-hygiene/no-identical-title
  it(`same title`, noop);
  // a block may share a test's title
  // expect-clean: bun-test-hygiene/no-identical-title
  describe("same title", noop);
  // `.each` titles are format strings
  test.each(table)("row %d", noop);
  // expect-clean: bun-test-hygiene/no-identical-title
  test.each(table)("row %d", noop);
});

describe("second block", () => {
  // the same title in another block
  // expect-clean: bun-test-hygiene/no-identical-title
  test("same title", noop);
});

// oxlint-disable-next-line bun-test-hygiene/no-identical-title
describe("first block", noop);
