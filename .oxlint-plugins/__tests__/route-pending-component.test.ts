import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import exceptionList from "../route-pending-component-exceptions.json" with { type: "json" };
import unmarkedList from "../route-pending-component-unmarked.json" with { type: "json" };
import { lintRuleAcrossFiles, lintSingleRule } from "./lint-single-rule.ts";

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

// The rule checks a module that marks a frame view; the mark goes last so
// the expected lines stay those of the source.
const pendingRule = async (source: string) =>
  await lintSingleRule(
    "pending-module-imports",
    `${source}\nexport const XPending = framePendingView(XPendingView);`,
    { plugin: PLUGIN, sourcePath: "x.pending.tsx" },
  );

const CONTEXT_PENDING_SOURCE = [
  'import { useTranslations } from "use-intl";',
  'import { Menu } from "@stll/ui/menu";',
  "export const XPending = () => <Menu>{useTranslations()('x')}</Menu>;",
].join("\n");

test("an unlisted pending module is context-free, marked or not", async () => {
  // A piece a frame view imports marks nothing itself, and is checked too.
  expect(
    await lintSingleRule("pending-module-imports", CONTEXT_PENDING_SOURCE, {
      plugin: PLUGIN,
      sourcePath: "apps/web/src/components/new-piece.pending.tsx",
    }),
  ).toEqual([1, 2, 3]);
});

test("a route's pending view is marked for the frame", async () => {
  const results = await lintRuleAcrossFiles(
    "route-pending-component",
    {
      "marked/route.tsx": [
        'import { XPage } from "./x.page";',
        'import { XPending } from "./x.pending";',
        'createFileRoute("/x")({ component: XPage, pendingComponent: XPending });',
      ].join("\n"),
      "marked/x.pending.tsx":
        "export const XPending = framePendingView(() => null);",
      "unmarked/route.tsx": [
        'import { XPage } from "./x.page";',
        'import { XPending } from "./x.pending";',
        'createFileRoute("/x")({ component: XPage, pendingComponent: XPending });',
      ].join("\n"),
      "unmarked/x.pending.tsx": "export const XPending = () => null;",
    },
    { plugin: PLUGIN },
  );
  expect(results["marked/route.tsx"]).toEqual([]);
  expect(results["unmarked/route.tsx"]).toEqual([3]);
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
        'import { Skeleton } from "@stll/ui/skeleton";',
        'import { TableSkeletonRows } from "@stll/ui/table-shell";',
        'import { RowsPending } from "./rows.pending";',
        'import { columnWidths } from "./columns.logic";',
        'import type { User } from "@/lib/authenticated-user-context";',
      ].join("\n"),
    ),
  ).toEqual([]);
  expect(
    await pendingRule(
      [
        'import { Dialog } from "@stll/ui/dialog";',
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

test("a pending half may read the URL loosely and the cache synchronously", async () => {
  expect(
    await pendingRule(
      [
        'import { useParams, useSearch } from "@tanstack/react-router";',
        'import { cachedRoleGrants } from "@/lib/permissions/cached-role-grants";',
        "const A = () => useParams({ strict: false });",
        "const B = () => useSearch({ strict: false, select: (s) => s.q });",
      ].join("\n"),
    ),
  ).toEqual([]);
  expect(
    await pendingRule(
      [
        'import { useNavigate, useParams } from "@tanstack/react-router";',
        'import { cachedRoleGrants, roleOptions } from "@/lib/permissions";',
        "const A = () => useParams({ from: '/x' });",
        "const B = () => Route.useParams({ strict: false });",
        "const C = () => useSearch();",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("an aliased URL hook and a re-export are checked like the originals", async () => {
  expect(
    await pendingRule(
      [
        'import { useParams as readParams } from "@tanstack/react-router";',
        "const A = () => readParams({ strict: false });",
        "const B = () => readParams({ from: '/x' });",
        'export { Menu } from "@stll/ui/menu";',
        'export * from "@tanstack/react-query";',
        'export { RowsPending } from "./rows.pending";',
        'export type { Props } from "@stll/ui/menu";',
        'export { type MenuProps } from "@stll/ui/menu";',
      ].join("\n"),
    ),
  ).toEqual([3, 4, 5]);
});

test("a route pairs the page and pending view of one module stem", async () => {
  expect(
    await routeRule(
      [
        'import { APage } from "./-a.page";',
        'import { BPending } from "./-b.pending";',
        'createFileRoute("/a")({ component: APage, pendingComponent: BPending });',
      ].join("\n"),
    ),
  ).toEqual([3]);
});

// One oxlint run over pages and their siblings: a page with a `.pending`
// sibling renders the shell that sibling exports, through `./` or the `@/`
// alias; a same-named module in another directory is another page's.
test("a page module renders the shell of its own pending sibling", async () => {
  const chat = "apps/web/src/routes/chat";
  const pages = {
    "type-only/chat-index.page.tsx": [
      'import type { ShellProps } from "./chat-index.pending";',
      'import { ChatIndexShell } from "./chat-index.pending";',
      "export const ChatIndexPage = (props: ShellProps) => <div {...props} />;",
    ],
    "renders/chat-index.page.tsx": [
      'import { ChatIndexShell } from "./chat-index.pending";',
      "export const ChatIndexPage = () => <ChatIndexShell rows={null} />;",
    ],
    "other/chat-index.page.tsx": [
      'import { OtherShell } from "./other.pending";',
      "export const ChatIndexPage = () => <OtherShell />;",
    ],
    "alone/invoice.page.tsx": ["export const InvoicePage = () => <section />;"],
    [`${chat}/a.page.tsx`]: [
      'import { AShell } from "@/routes/chat/a.pending";',
      "export const APage = () => <AShell />;",
    ],
    [`${chat}/b.page.tsx`]: [
      'import { BShell } from "@/routes/law/b.pending";',
      "export const BPage = () => <BShell />;",
    ],
    [`${chat}/c.page.tsx`]: [
      'import { CShell } from "../law/c.pending";',
      "export const CPage = () => <CShell />;",
    ],
  };
  const siblings = Object.keys(pages)
    .filter((name) => !name.startsWith("alone/"))
    .map((name) => name.replace(/\.page\.tsx$/u, ".pending.tsx"));
  const results = await lintRuleAcrossFiles(
    "page-module-shell",
    {
      ...Object.fromEntries(
        Object.entries(pages).map(([name, lines]) => [name, lines.join("\n")]),
      ),
      ...Object.fromEntries(siblings.map((name) => [name, ""])),
    },
    { plugin: PLUGIN },
  );
  expect(
    Object.fromEntries(Object.keys(pages).map((name) => [name, results[name]])),
  ).toEqual({
    "type-only/chat-index.page.tsx": [1],
    "renders/chat-index.page.tsx": [],
    "other/chat-index.page.tsx": [1],
    // No loading view yet: the route rule's finding, not this rule's.
    "alone/invoice.page.tsx": [],
    [`${chat}/a.page.tsx`]: [],
    [`${chat}/b.page.tsx`]: [1],
    [`${chat}/c.page.tsx`]: [1],
  });
});

test("the exception list names existing route files once each, sorted", () => {
  const files: readonly string[] = exceptionList;
  expect(files).toEqual([...new Set(files)].toSorted());
  for (const file of files) {
    expect(existsSync(path.join(REPOSITORY_ROOT, file))).toBe(true);
  }
});

test("the unmarked list names existing pending modules once each, sorted", () => {
  const files: readonly string[] = unmarkedList;
  expect(files).toEqual([...new Set(files)].toSorted());
  for (const file of files) {
    expect(file).toEndWith(".pending.tsx");
    expect(existsSync(path.join(REPOSITORY_ROOT, file))).toBe(true);
  }
});
