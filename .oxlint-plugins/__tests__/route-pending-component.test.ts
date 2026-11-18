import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import exceptionList from "../route-pending-component-exceptions.json" with { type: "json" };
import { lintSingleRule } from "./lint-single-rule.ts";

const PLUGIN = "route-pending-component";
const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");

const routeRule = async (source: string) =>
  await lintSingleRule("route-pending-component", source, {
    sourcePath: "route.tsx",
  });

test("accepts a page and its pending half imported from sibling modules", async () => {
  expect(
    await routeRule(
      [
        'import { ChatIndexPage } from "./-components/chat-index.page";',
        'import { ChatIndexPending } from "./-components/chat-index.pending";',
        'createFileRoute("/chat/")({ component: ChatIndexPage, pendingComponent: ChatIndexPending });',
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("rejects a page route without a pending view", async () => {
  expect(
    await routeRule(
      [
        'import { ChatIndexPage } from "./-components/chat-index.page";',
        'createFileRoute("/chat/")({ component: ChatIndexPage });',
      ].join("\n"),
    ),
  ).toEqual([2]);
});

test("rejects components defined in the route file or imported from elsewhere", async () => {
  expect(
    await routeRule(
      [
        'import { Page } from "./-components/page";',
        'import { PagePending } from "./-components/page.pending";',
        "function Local() { return null; }",
        'createFileRoute("/a")({ component: Local, pendingComponent: PagePending });',
        'createFileRoute("/b")({ component: Page, pendingComponent: PagePending });',
        'createFileRoute("/c")({ component: () => <Page routeState="loaded" />, pendingComponent: () => <Page routeState="pending" /> });',
      ].join("\n"),
    ),
  ).toEqual([4, 5, 6]);
});

test("rejects the generic skeleton and lazy route components", async () => {
  expect(
    await routeRule(
      [
        'import { DefaultPendingComponent } from "@/components/route-components";',
        'import { Page } from "./-components/x.page";',
        'createFileRoute("/a")({ component: Page, pendingComponent: DefaultPendingComponent });',
        'createFileRoute("/b")({ component: Page, pendingComponent: () => <DefaultPendingComponent className="h-full" /> });',
        'createFileRoute("/c")({ component: lazyRouteComponent(async () => import("./-x"), "X"), pendingComponent: lazyRouteComponent(async () => import("./-x"), "XPending") });',
      ].join("\n"),
    ),
  ).toEqual([3, 4, 5, 5, 5]);
});

test("a layout delegates to its page, and only a layout may", async () => {
  expect(
    await routeRule(
      [
        "function Layout() { return <Shell><Outlet /></Shell>; }",
        'createFileRoute("/a")({ component: Layout, pendingComponent: LeafPendingView });',
      ].join("\n"),
    ),
  ).toEqual([]);
  expect(
    await routeRule(
      [
        'import { Page } from "./-components/x.page";',
        'createFileRoute("/a")({ component: Page, pendingComponent: LeafPendingView });',
      ].join("\n"),
    ),
  ).toEqual([2]);
});

test("a redirect names its target instead of a page", async () => {
  expect(
    await routeRule(
      'createFileRoute("/settings/")({ component: redirectRouteComponent({ to: "/settings/account/profile" }) });',
    ),
  ).toEqual([]);
});

test("routes without a component are not pages", async () => {
  expect(
    await routeRule(
      'createFileRoute("/_protected")({ beforeLoad: guard, pendingComponent: DefaultPendingComponent });',
    ),
  ).toEqual([]);
});

const pendingRule = async (source: string) =>
  await lintSingleRule("pending-module-imports", source, {
    plugin: PLUGIN,
    sourcePath: "x.pending.tsx",
  });

test("a pending half imports only pending-safe modules", async () => {
  expect(
    await pendingRule(
      [
        'import type { ReactNode } from "react";',
        'import { type QueryView } from "@/lib/query-view.logic";',
        'import { SkillIcon } from "@stll/ui/icons";',
        'import { LandingRowsPending } from "@stll/ui/landing-shell";',
        'import { PendingText } from "@/components/pending-text";',
        'import { RowsPending } from "./rows.pending";',
        'import { columnWidths } from "./columns.logic";',
        'import type { User } from "@/lib/authenticated-user-context";',
      ].join("\n"),
    ),
  ).toEqual([]);
  expect(
    await pendingRule(
      [
        'import { Skeleton } from "@stll/ui/skeleton";',
        'import { DefaultPendingComponent } from "@/components/route-components";',
        'import { Menu } from "@stll/ui/menu";',
        'import { useQuery } from "@tanstack/react-query";',
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("a pending half calls no context hooks and loads nothing lazily", async () => {
  expect(
    await pendingRule(
      [
        "const A = () => { const t = useTranslations(); return t('x'); };",
        "const B = () => Route.useSearch();",
        "const C = lazy(async () => import('./c'));",
        "const D = () => useQuery(options);",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 3, 4]);
});

test("a page module renders the shell from its sibling pending module", async () => {
  expect(
    await lintSingleRule(
      "page-module-shell",
      'import { ChatIndexShell } from "@/routes/_protected.chat/-components/chat-index.pending";',
      { plugin: PLUGIN, sourcePath: "chat-index.page.tsx" },
    ),
  ).toEqual([]);
  expect(
    await lintSingleRule(
      "page-module-shell",
      'import { OtherShell } from "./other.pending";',
      { plugin: PLUGIN, sourcePath: "chat-index.page.tsx" },
    ),
  ).toEqual([1]);
});

test("the exception list names existing route files once each, sorted", () => {
  const files: readonly string[] = exceptionList;
  expect(files).toEqual([...new Set(files)].toSorted());
  for (const file of files) {
    expect(existsSync(path.join(REPOSITORY_ROOT, file))).toBe(true);
  }
});
