// Passive regression fixture for `bun-test-hygiene`.
//
// Each `oxlint-disable-next-line` suppresses a case the rule MUST flag; if the
// rule regresses, the unused directive fails the fixture harness. A blank line
// separates each case description from a disabled-test case, because a
// comment directly above a `.skip` counts as its reason.

import { nextMacrotask } from "@stll/concurrency/event-loop";
import { sleep as ownerSleep } from "@stll/concurrency/sleep";
import * as bun from "bun";
import { SQL, SQL as PgClient } from "bun";
import * as bt from "bun:test";
import {
  describe,
  expect,
  expect as assertThat,
  it,
  test as check,
  test,
  xdescribe,
  xit,
  xtest,
} from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql";
import { setTimeout as delay } from "node:timers/promises";

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

// --- no-forced-database-drop ---
declare const fixtureDatabaseName: string;
// oxlint-disable-next-line bun-test-hygiene/no-forced-database-drop -- Fixture exercises rejected database teardown.
const _forcedDrop = `DROP DATABASE "${fixtureDatabaseName}" WITH (FORCE)`;
// expect-clean: bun-test-hygiene/no-forced-database-drop
const _normalDrop = "DROP DATABASE IF EXISTS fixture";

// --- no-unmanaged-database-client ---
declare const databaseUrl: string;
declare const openedClient: SQL;

// oxlint-disable-next-line bun-test-hygiene/no-unmanaged-database-client
const _bunClient = new SQL({ url: databaseUrl, max: 1 });
// aliased, namespace member, and the runtime global
// oxlint-disable-next-line bun-test-hygiene/no-unmanaged-database-client
const _aliasedClient = new PgClient(databaseUrl);
// oxlint-disable-next-line bun-test-hygiene/no-unmanaged-database-client
const _namespaceClient = new bun.SQL(databaseUrl);
// oxlint-disable-next-line bun-test-hygiene/no-unmanaged-database-client
const _globalClient = new Bun.SQL(databaseUrl);
// drizzle opening its own client from a URL or a `connection` option
// oxlint-disable-next-line bun-test-hygiene/no-unmanaged-database-client
const _urlDatabase = drizzle(databaseUrl);
// oxlint-disable-next-line bun-test-hygiene/no-unmanaged-database-client
const _connectionDatabase = drizzle({ connection: databaseUrl });
// drizzle wrapping a client opened elsewhere
// expect-clean: bun-test-hygiene/no-unmanaged-database-client
const _wrappedDatabase = drizzle({ client: openedClient });
// a driver error class reached through the client export
// expect-clean: bun-test-hygiene/no-unmanaged-database-client
const _driverError = new SQL.PostgresError("terminating connection", {
  code: "ERR_POSTGRES_SERVER_ERROR",
  errno: "57P01",
  detail: "",
  hint: "",
  severity: "FATAL",
});

// --- no-promise-matchers ---

declare const pending: Promise<number>;
declare const playwrightExpect: (value: unknown) => {
  rejects: { toThrow: () => Promise<void> };
};

// oxlint-disable-next-line bun-test-hygiene/no-promise-matchers
const _rejects = expect(pending).rejects.toThrow("boom");
// oxlint-disable-next-line bun-test-hygiene/no-promise-matchers
const _resolves = expect(pending).resolves.toBe(1);
// aliased import
// oxlint-disable-next-line bun-test-hygiene/no-promise-matchers
const _aliased = assertThat(pending).resolves.toBe(1);
// namespace member
// oxlint-disable-next-line bun-test-hygiene/no-promise-matchers
const _namespace = bt.expect(pending).rejects.toBeInstanceOf(Error);
// computed member
// oxlint-disable-next-line bun-test-hygiene/no-promise-matchers, typescript/dot-notation -- the computed form is the case under test
const _computed = expect(pending)["rejects"].toBeInstanceOf(Error);
// a negation before the promise matcher
// oxlint-disable-next-line bun-test-hygiene/no-promise-matchers
const _negatedRejects = expect(pending).not.rejects.toThrow("boom");
// oxlint-disable-next-line bun-test-hygiene/no-promise-matchers
const _negatedResolves = expect(pending).not.resolves.toBe(2);
// an awaited value
// expect-clean: bun-test-hygiene/no-promise-matchers
const _awaited = async () => expect(await pending).toBe(1);
// a framework whose `expect` is not from `bun:test`
// expect-clean: bun-test-hygiene/no-promise-matchers
const _playwright = playwrightExpect(pending).rejects.toThrow();

// --- no-polling-loop ---

declare const done: () => boolean;
declare const schedule: (work: () => Promise<void>) => void;
declare const chunks: AsyncIterable<string>;
const pause = async (milliseconds: number) =>
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const _pollingLoops = async () => {
  // a predicate in the loop test
  // oxlint-disable-next-line bun-test-hygiene/no-polling-loop
  while (!done()) {
    await Bun.sleep(10);
  }
  // a deadline with a conditional exit
  const deadline = Date.now() + 1000;
  // oxlint-disable-next-line bun-test-hygiene/no-polling-loop
  while (Date.now() < deadline) {
    if (done()) {
      return;
    }
    await bun.sleep(5);
  }
  // a counter bound with a conditional exit
  // oxlint-disable-next-line bun-test-hygiene/no-polling-loop
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (done()) {
      break;
    }
    await ownerSleep(5);
  }
  // a counter bound joined with a predicate
  // oxlint-disable-next-line bun-test-hygiene/no-polling-loop
  for (let attempt = 0; attempt < 100 && !done(); attempt += 1) {
    await delay(5);
  }
  // a timer promise, a microtask tick and the next macrotask
  // oxlint-disable-next-line bun-test-hygiene/no-polling-loop
  while (!done()) {
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  // oxlint-disable-next-line bun-test-hygiene/no-polling-loop
  do {
    await Promise.resolve();
  } while (!done());
  // oxlint-disable-next-line bun-test-hygiene/no-polling-loop
  while (!done()) {
    await nextMacrotask();
  }
  // a local helper that only waits
  // oxlint-disable-next-line bun-test-hygiene/no-polling-loop
  while (!done()) {
    await pause(5);
  }
};

const _fixedLoops = async () => {
  // a counter the loop advances flushes a fixed number of ticks
  // expect-clean: bun-test-hygiene/no-polling-loop
  for (let tick = 0; tick < 3; tick += 1) {
    await Bun.sleep(0);
  }
  // a bound read from a call is still a fixed count
  // expect-clean: bun-test-hygiene/no-polling-loop
  for (let tick = 0; tick < Number(flag); tick += 1) {
    await Bun.sleep(1);
  }
  // a wait inside a callback runs on the callback's schedule
  // expect-clean: bun-test-hygiene/no-polling-loop
  while (!done()) {
    schedule(async () => {
      await Bun.sleep(1);
    });
  }
  // a loop that awaits only the work itself
  // expect-clean: bun-test-hygiene/no-polling-loop
  while (!done()) {
    await Promise.all([]);
  }
  // stepping through a sequence
  // expect-clean: bun-test-hygiene/no-polling-loop
  for await (const chunk of chunks) {
    if (chunk === "end") {
      break;
    }
    await Bun.sleep(1);
  }
};
