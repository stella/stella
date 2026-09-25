import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import { IntlProvider } from "use-intl";

import { SidebarProvider } from "@/components/sidebar";
import en from "@/i18n/langs/en.json";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { PublicLawInspector } from "@/routes/law/-components/public-law-inspector";

const DECISION_HREF = "/law/cze/cases/nss/7-azs-172-2025";
const RAIL_MARKER = 'data-slot="inspector-rail"';

const MEMBER: AuthenticatedUser = {
  activeOrganizationId: "organization-1",
  email: "member@example.com",
  id: "user-1",
  image: null,
  name: "Member",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};

const rootRoute = createRootRoute();

const TestRouter = ({ children }: { children: ReactNode }) => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [DECISION_HREF] }),
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/auth" }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/law/$country/cases/$court/$slug",
      }),
    ]),
  });

  return (
    <RouterContextProvider router={router}>{children}</RouterContextProvider>
  );
};

const renderOnDecision = (node: ReactNode): string =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <TestRouter>
          <SidebarProvider defaultOpen>{node}</SidebarProvider>
        </TestRouter>
      </IntlProvider>
    </QueryClientProvider>,
  );

const railCount = (markup: string) => markup.split(RAIL_MARKER).length - 1;

describe("the public law inspector on a decision page", () => {
  // A decision page once drew no rail for a visitor: the shell yielded to a
  // dock the case reader only mounted for a member, so the decision's details
  // tab was seeded into a store nothing drew.
  test("a visitor gets exactly one rail", () => {
    expect(railCount(renderOnDecision(<PublicLawInspector />))).toBe(1);
  });

  test("a member gets exactly one rail", () => {
    expect(
      railCount(
        renderOnDecision(
          <AuthenticatedUserProvider user={MEMBER}>
            <PublicLawInspector />
          </AuthenticatedUserProvider>,
        ),
      ),
    ).toBe(1);
  });
});

const WEB_SOURCE = nodePath.resolve(import.meta.dirname, "../../..");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.tsx?$/u;
const DOCK_IMPORT_PATTERN =
  /import\s*\{[^}]*\bInspectorDock\b[^}]*\}\s*from\s*"@stll\/ui\/inspector"/u;

const listSourceFiles = (directory: string): string[] => {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = nodePath.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
      continue;
    }

    if (
      SOURCE_EXTENSIONS.has(nodePath.extname(entry.name)) &&
      !TEST_FILE_PATTERN.test(entry.name)
    ) {
      files.push(path);
    }
  }

  return files;
};

describe("inspector dock ownership", () => {
  // One dock per surface, owned by its shell: a reader that docks its own
  // either stacks a second column or, if the shell yields to it, leaves every
  // reader it does not mount for without one.
  test("only the shells mount the inspector dock", () => {
    const owners = listSourceFiles(WEB_SOURCE)
      .filter((path) => DOCK_IMPORT_PATTERN.test(readFileSync(path, "utf-8")))
      .map((path) => nodePath.relative(WEB_SOURCE, path))
      .toSorted();

    expect(owners).toEqual([
      "components/public-inspector-rail.tsx",
      "routes/_protected.tsx",
    ]);
  });
});
