import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "detached-link-options";
const lint = async (
  source: string,
  sourcePath = "apps/web/src/routes/links.tsx",
) =>
  await lintSingleRule(RULE_NAME, source, {
    plugin: "route-links",
    sourcePath,
  });

test("reports detached route objects across common expression shapes", async () => {
  const source = [
    'const ternary = condition ? null : { to: "/law", search: { year: 2024 } };',
    'const asserted = { to: "/law" } as const;',
    'const literalAssertion = { to: "/law" as const };',
    'const detachedArray = [{ to: "/law" }];',
    'const returned = () => ({ to: "/law" });',
    'const nestedInArgument = consume({ link: { to: "/law" } });',
    'const nestedInCall = consume([{ to: "/law" }]);',
    'const spread = <Thing {...{ to: "/law" }} />;',
    'const computed = { ["to"]: "/law" };',
    'const satisfied = { to: "/law" } satisfies RouteLink;',
    'const memberCallNested = router.other({ link: { to: "/law" } });',
  ].join("\n");

  expect(await lint(source)).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("allows direct call arguments, linkOptions arrays, and JSX attributes", async () => {
  const source = [
    'const direct = navigate({ to: "/law" });',
    'const constructed = new LinkTarget({ to: "/law" });',
    'const options = linkOptions({ to: "/law" });',
    'const arrayOptions = linkOptions([{ to: "/law" }]);',
    'const memberArrayOptions = router.linkOptions([{ to: "/law" }]);',
    'const jsx = <Thing route={{ to: "/law" }} />;',
    'const unrelated = { to: "https://example.org" };',
  ].join("\n");

  expect(await lint(source)).toEqual([]);
});

test("limits detection to web source and files importing the router", async () => {
  expect(
    await lint('const config = { to: "/law" };', "packages/ui/src/config.ts"),
  ).toEqual([]);
  expect(
    await lint(
      'import { Link } from "@tanstack/react-router";\nconst link = { to: "/law" };',
      "packages/ui/src/navigation.test.ts",
    ),
  ).toEqual([2]);
  expect(
    await lint('const config = { to: "/law" };', "apps/web/e2e/routes.ts"),
  ).toEqual([]);
  expect(
    await lint(
      'const link = { to: "/law" };',
      "apps/web/src/components/nav.tsx",
    ),
  ).toEqual([1]);
});
