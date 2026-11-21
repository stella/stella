import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects strict route data hooks including imported aliases", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { useLoaderData, useMatch, useParams, useRouteContext as context, useSearch } from "@tanstack/react-router";\nuseLoaderData({ from: "/route" });\nuseMatch({ from: "/route" });\nuseParams({ from: "/route" });\ncontext({ from: "/route" });\nuseSearch({ from: "/route" });',
    ),
  ).toEqual([2, 3, 4, 5, 6]);
});

test("rejects route API data reads while retaining navigation", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { getRouteApi as route } from "@tanstack/react-router";\nconst api = route("/route");\napi.useLoaderData();\napi.useRouteContext();\napi.useNavigate();',
    ),
  ).toEqual([3, 4]);
});

test("accepts explicit nonthrowing data reads", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { useMatch, useParams, useSearch, useRouteContext } from "@tanstack/react-router";\nuseMatch({ from: "/route", shouldThrow: false });\nuseParams({ from: "/route", strict: false });\nuseSearch({ from: "/route", strict: false });\nuseRouteContext({ from: "/route", strict: false });',
    ),
  ).toEqual([]);
});

test("ignores unrelated hooks and reads without strict route identity", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { useMatch } from "@tanstack/react-router";\nimport { useParams } from "other-router";\nuseMatch({ select: value => value });\nuseParams({ from: "/route" });',
    ),
  ).toEqual([]);
});

test("rejects explicitly strict throwing and unknown opt-out values", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { useMatch, useParams, useRouteContext } from "@tanstack/react-router";\nuseMatch({ from: "/route", shouldThrow: true });\nuseParams({ from: "/route", strict: true });\nuseRouteContext({ from: "/route", strict: configuredStrict });\nuseMatch({ from: "/route", shouldThrow: configuredThrow });',
    ),
  ).toEqual([2, 3, 4, 5]);
});
