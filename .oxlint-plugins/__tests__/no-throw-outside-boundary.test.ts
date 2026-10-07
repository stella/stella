import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects new errors wrapped catch errors and redirects", async () => {
  expect(
    await lintSingleRule(
      "no-throw-outside-boundary",
      'throw new DomainError("bad");\ntry { run(); } catch (cause) { throw wrap(cause); }\nthrow redirect("/login");',
      { plugin: "result-boundary" },
    ),
  ).toEqual([1, 2, 3]);
});

test("accepts synchronous rethrows and canonical panic aliases", async () => {
  expect(
    await lintSingleRule(
      "no-throw-outside-boundary",
      'import { panic as stop } from "better-result";\ntry { run(); } catch (cause) { throw cause; }\nthrow stop("invariant");',
      { plugin: "result-boundary" },
    ),
  ).toEqual([]);
});

test("rejects captured catch values thrown inside callbacks", async () => {
  expect(
    await lintSingleRule(
      "no-throw-outside-boundary",
      "try { run(); } catch (cause) { const fail = () => { throw cause; }; }",
      { plugin: "result-boundary" },
    ),
  ).toEqual([1]);
});

test("rejects a shadowed local with the catch binding name", async () => {
  expect(
    await lintSingleRule(
      "no-throw-outside-boundary",
      "try { run(); } catch (cause) { { const cause = other; throw cause; } }",
      { plugin: "result-boundary" },
    ),
  ).toEqual([1]);
});

test("rejects a same named panic imported from another module", async () => {
  expect(
    await lintSingleRule(
      "no-throw-outside-boundary",
      'import { panic } from "other-library";\nthrow panic("bad");',
      { plugin: "result-boundary" },
    ),
  ).toEqual([2]);
});

test("accepts typed results and standalone invariant termination", async () => {
  expect(
    await lintSingleRule(
      "no-throw-outside-boundary",
      'function run() { return Result.err(error); }\npanic("invariant");',
      { plugin: "result-boundary" },
    ),
  ).toEqual([]);
});
