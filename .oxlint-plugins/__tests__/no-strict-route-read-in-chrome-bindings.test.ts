import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("reports actual imported strict hooks including aliases", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { useLoaderData, useMatch as match, useParams, useRouteContext, useSearch } from "@tanstack/react-router";\nuseLoaderData({ from: "/route" });\nmatch({ from: "/route" });\nuseParams({ from: "/route" });\nuseRouteContext({ from: "/route" });\nuseSearch({ from: "/route" });',
    ),
  ).toEqual([2, 3, 4, 5, 6]);
});

test("distinguishes imported hooks from a function parameter", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { useMatch as read } from "@tanstack/react-router";\nfunction local(read) { read({ from: "/route" }); }\nread({ from: "/route" });',
    ),
  ).toEqual([3]);
});

test("distinguishes imported hooks from a destructured parameter", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { useMatch as read } from "@tanstack/react-router";\nfunction local({ read }) { read({ from: "/route" }); }\nread({ from: "/route" });',
    ),
  ).toEqual([3]);
});

test("distinguishes imported hooks from a block binding", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { useMatch as read } from "@tanstack/react-router";\n{ const read = localHook; read({ from: "/route" }); }\nread({ from: "/route" });',
    ),
  ).toEqual([3]);
});

test("distinguishes imported hooks from a function-local binding", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { useMatch as read } from "@tanstack/react-router";\nfunction local() { const read = localHook; read({ from: "/route" }); }\nread({ from: "/route" });',
    ),
  ).toEqual([3]);
});

test("distinguishes imported hooks from a hoisted function declaration", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { useMatch as read } from "@tanstack/react-router";\nfunction local() { read({ from: "/route" }); function read(options) { return options; } }\nread({ from: "/route" });',
    ),
  ).toEqual([3]);
});

test("distinguishes imported hooks from a hoisted var declaration", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { useMatch as read } from "@tanstack/react-router";\nfunction local() { read({ from: "/route" }); var read = localHook; }\nread({ from: "/route" });',
    ),
  ).toEqual([3]);
});

test("reports actual route API data hooks while allowing navigation", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { getRouteApi as route } from "@tanstack/react-router";\nconst api = route("/route");\napi.useLoaderData();\napi.useMatch();\napi.useParams();\napi.useRouteContext();\napi.useSearch();\napi.useNavigate();',
    ),
  ).toEqual([3, 4, 5, 6, 7]);
});

test("distinguishes route API receivers from a parameter", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { getRouteApi } from "@tanstack/react-router";\nconst api = getRouteApi("/route");\nfunction local(api) { api.useParams(); }\napi.useParams();',
    ),
  ).toEqual([4]);
});

test("distinguishes route API receivers from a block binding", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { getRouteApi } from "@tanstack/react-router";\nconst api = getRouteApi("/route");\n{ const api = localApi; api.useParams(); }\napi.useParams();',
    ),
  ).toEqual([4]);
});

test("distinguishes route API receivers from a function-local binding", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { getRouteApi } from "@tanstack/react-router";\nconst api = getRouteApi("/route");\nfunction local() { const api = localApi; api.useParams(); }\napi.useParams();',
    ),
  ).toEqual([4]);
});

test("distinguishes route API receivers from a hoisted var binding", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { getRouteApi } from "@tanstack/react-router";\nconst api = getRouteApi("/route");\nfunction local() { api.useParams(); var api = localApi; }\napi.useParams();',
    ),
  ).toEqual([4]);
});

test("distinguishes getRouteApi factories from a parameter", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { getRouteApi as route } from "@tanstack/react-router";\nfunction local(route) { const api = route("/local"); api.useParams(); }\nconst actual = route("/route");\nactual.useParams();',
    ),
  ).toEqual([4]);
});

test("distinguishes getRouteApi factories from a block binding", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { getRouteApi as route } from "@tanstack/react-router";\n{ const route = localFactory; const api = route("/local"); api.useParams(); }\nconst actual = route("/route");\nactual.useParams();',
    ),
  ).toEqual([4]);
});

test("distinguishes getRouteApi factories from a function-local binding", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { getRouteApi as route } from "@tanstack/react-router";\nfunction local() { const route = localFactory; const api = route("/local"); api.useParams(); }\nconst actual = route("/route");\nactual.useParams();',
    ),
  ).toEqual([4]);
});

test("distinguishes getRouteApi factories from a hoisted function declaration", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { getRouteApi as route } from "@tanstack/react-router";\nfunction local() { const api = route("/local"); api.useParams(); function route(path) { return localApi; } }\nconst actual = route("/route");\nactual.useParams();',
    ),
  ).toEqual([4]);
});

test("continues reporting imported route API bindings with reassignment", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { getRouteApi } from "@tanstack/react-router";\nlet api = getRouteApi("/first");\napi = getRouteApi("/second");\napi.useRouteContext();',
    ),
  ).toEqual([4]);
});

test("accepts explicit nonthrowing imported hooks and unrelated implementations", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { useMatch, useParams } from "@tanstack/react-router";\nimport { useRouteContext } from "other-router";\nuseMatch({ from: "/route", shouldThrow: false });\nuseParams({ from: "/route", strict: false });\nuseRouteContext({ from: "/route" });',
    ),
  ).toEqual([]);
});

test("still reports strict true and unknown opt-out values", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      'import { useMatch, useParams } from "@tanstack/react-router";\nuseMatch({ from: "/route", shouldThrow: true });\nuseParams({ from: "/route", strict: configured });',
    ),
  ).toEqual([2, 3]);
});

test("reports router namespace and stable factory aliases by their imported binding", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      [
        'import * as router from "@tanstack/react-router";',
        "const read = router.useMatch;",
        "const { getRouteApi: factory } = router;",
        "const route = factory;",
        'const api = route("/route");',
        'router.useSearch({ from: "/route" });',
        'read({ from: "/route" });',
        "api.useParams();",
      ].join("\n"),
    ),
  ).toEqual([6, 7, 8]);
});

test("does not identify destructured factory-result properties as the route API receiver", async () => {
  expect(
    await lintSingleRule(
      "no-strict-route-read-in-chrome",
      [
        'import { getRouteApi } from "@tanstack/react-router";',
        'const { metadata: api } = getRouteApi("/route");',
        "api.useParams();",
      ].join("\n"),
    ),
  ).toEqual([]);
});
