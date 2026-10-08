import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects whole object subscriptions through every router hook", async () => {
  expect(
    await lintSingleRule(
      "require-router-select",
      [
        "useParams();",
        "useSearch(options);",
        "useRouteContext({});",
        "Route.useParams();",
        "Route.useSearch(options);",
        "Route.useRouteContext({});",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});

test("allows explicit field selection on standalone and route scoped hooks", async () => {
  expect(
    await lintSingleRule(
      "require-router-select",
      [
        "useParams({ select: (params) => params.id });",
        "useSearch({ select: (search) => search.query });",
        "useRouteContext({ select: (context) => context.member });",
        "Route.useParams({ select: (params) => params.id });",
        "Route.useSearch({ select: (search) => search.query });",
        "Route.useRouteContext({ select: (context) => context.member });",
        "useLocation();",
      ].join("\n"),
    ),
  ).toEqual([]);
});
