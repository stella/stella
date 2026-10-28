import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-route-context-in-panel-tabs";

test("panel tabs reject route context hooks regardless of route or strictness", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        'import { useRouteContext as readContext } from "@tanstack/react-router";',
        'readContext({ from: "/_protected" });',
        'readContext({ from: "/knowledge", strict: false });',
        "readContext();",
        'import * as router from "@tanstack/react-router";',
        'router.useRouteContext({ from: "/law" });',
        "const alias = readContext;",
        'alias({ from: "/tools" });',
      ].join("\n"),
    ),
  ).toEqual([2, 3, 4, 6, 8]);
});

test("panel tabs reject route APIs and captured context methods", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        'import { Route } from "@/routes/_protected";',
        'import { getRouteApi as route } from "@tanstack/react-router";',
        "Route.useRouteContext();",
        'const api = route("/_protected");',
        "api.useRouteContext();",
        'route("/law").useRouteContext();',
        'api["useRouteContext"]();',
        "const read = api.useRouteContext;",
        "const { useRouteContext: readContext } = Route;",
      ].join("\n"),
    ),
  ).toEqual([3, 5, 6, 7, 8, 9]);
});

test("panel tabs accept provider hooks and route-neutral navigation", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        'import { useAuthenticatedUser, useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";',
        'import { useNavigate, useMatch } from "@tanstack/react-router";',
        "useAuthenticatedUser();",
        "useMaybeAuthenticatedUser();",
        "useNavigate();",
        'useMatch({ from: "/_protected", strict: false, shouldThrow: false });',
        "Route.useNavigate();",
        'import { useRouteContext } from "other-library";',
        "useRouteContext();",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("panel tabs reject route-specific params, loader data, and strict matches", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        'import { useParams, useMatch } from "@tanstack/react-router";',
        'useParams({ from: "/knowledge" });',
        'useMatch({ from: "/knowledge" });',
        "Route.useParams();",
        "Route.useLoaderData();",
      ].join("\n"),
    ),
  ).toEqual([2, 3, 4, 5]);
});
