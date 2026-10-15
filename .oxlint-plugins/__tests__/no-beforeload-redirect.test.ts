import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects unconditional before load and loader redirects", async () => {
  expect(
    await lintSingleRule(
      "no-beforeload-redirect",
      'createFileRoute("/")({ beforeLoad: () => { throw redirect({ to: "/target" }); } });\ncreateFileRoute("/other")({ loader: () => redirect({ to: "/target" }) });',
    ),
  ).toEqual([1, 2]);
});

test("rejects both redirect branches even with a component", async () => {
  expect(
    await lintSingleRule(
      "no-beforeload-redirect",
      'createFileRoute("/")({ component: Page, beforeLoad: () => { if (ok) return redirect(a); else throw redirect(b); } });\ncreateFileRoute("/other")({ loader: () => ok ? redirect(a) : redirect(b) });',
    ),
  ).toEqual([1, 2]);
});

test("does not confuse nested helper returns with a route exit", async () => {
  expect(
    await lintSingleRule(
      "no-beforeload-redirect",
      'createFileRoute("/")({ beforeLoad: () => { const helper = () => value; throw redirect(a); } });',
    ),
  ).toEqual([1]);
});

test("accepts conditional guards that fall through or return normally", async () => {
  expect(
    await lintSingleRule(
      "no-beforeload-redirect",
      'createFileRoute("/")({ beforeLoad: () => { if (!session) throw redirect(a); } });\ncreateFileRoute("/other")({ loader: () => { if (ok) return value; throw redirect(a); } });',
    ),
  ).toEqual([]);
});

test("accepts component navigation and unrelated config objects", async () => {
  expect(
    await lintSingleRule(
      "no-beforeload-redirect",
      'createFileRoute("/")({ component: () => <Navigate to="/target" /> });\nconfigure({ beforeLoad: () => redirect(a) });',
      { sourcePath: "apps/web/src/components/example.tsx" },
    ),
  ).toEqual([]);
});
