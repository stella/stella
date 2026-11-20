import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { VIEW_SWITCH_PENDING } from "@/routes/-pending-view.logic";

// A view switch replaces the `$viewId` match and the matches under it, so
// these routes decide how long the outgoing view stays on screen.
const VIEW_SWITCH_ROUTE_PREFIX = "/_protected/workspaces/$workspaceId/$viewId";

// Each timing option, read from the shared constant in the route's options.
const REQUIRED_OPTIONS = Object.keys(VIEW_SWITCH_PENDING).map(
  (option) => `${option}: VIEW_SWITCH_PENDING.${option},`,
);

type RouteSource = { file: string; source: string };

const routeIdOf = (source: string) =>
  /createFileRoute\(\s*"(?<id>[^"]+)"/u.exec(source)?.groups?.["id"];

const isViewSwitchRoute = ({ source }: RouteSource) => {
  const id = routeIdOf(source);
  return (
    id !== undefined &&
    (id === VIEW_SWITCH_ROUTE_PREFIX ||
      id.startsWith(`${VIEW_SWITCH_ROUTE_PREFIX}/`))
  );
};

/**
 * View-switch routes on the wrong pending timing. A route with `loaderDeps`
 * also gets a new match from a search change inside its own page (the
 * document page's `field` when a saved version opens); a pending view shown
 * early there would unmount the page and the state it hands over, so it
 * keeps the router default. Every other route takes `VIEW_SWITCH_PENDING`.
 */
const findMistimedViewRoutes = (sources: readonly RouteSource[]) =>
  sources
    .filter(isViewSwitchRoute)
    .filter(({ source }) =>
      source.includes("loaderDeps:")
        ? source.includes("VIEW_SWITCH_PENDING")
        : REQUIRED_OPTIONS.some((option) => !source.includes(option)),
    )
    .map(({ file }) => file);

const readRouteSources = async (directory: string) => {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/u.test(entry.name) &&
        !entry.name.startsWith("-"),
    )
    .map((entry) => path.join(entry.parentPath, entry.name));
  return await Promise.all(
    files.map(async (file) => ({
      file: repoRelativePath(directory, file),
      source: await readFile(file, "utf-8"),
    })),
  );
};

test("every route a view switch lands on takes the view-switch pending timing", async () => {
  const sources = await readRouteSources(import.meta.dir);
  const viewRoutes = sources.filter(isViewSwitchRoute);

  // The view layout, its body and the document page; fewer means the prefix
  // stopped matching and the check below would pass on nothing.
  expect(viewRoutes.length).toBeGreaterThanOrEqual(3);
  expect(findMistimedViewRoutes(sources)).toEqual([]);
});

test("the check names a view route on the wrong timing", () => {
  const timed = REQUIRED_OPTIONS.join("\n  ");
  const sources = [
    {
      file: "view.timeline.tsx",
      source: `createFileRoute(\n  "${VIEW_SWITCH_ROUTE_PREFIX}/timeline",\n)({ pendingComponent: TimelinePending })`,
    },
    {
      file: "view.record.tsx",
      source: `createFileRoute("${VIEW_SWITCH_ROUTE_PREFIX}/record")({\n  loaderDeps: ({ search }) => search,\n  ${timed}\n})`,
    },
    {
      file: "view.document.tsx",
      source: `createFileRoute("${VIEW_SWITCH_ROUTE_PREFIX}/document")({\n  loaderDeps: ({ search }) => search,\n})`,
    },
    {
      file: "lists.tsx",
      source: `createFileRoute("/_protected/workspaces/$workspaceId/lists")({})`,
    },
    {
      file: "view.route.tsx",
      source: `createFileRoute("${VIEW_SWITCH_ROUTE_PREFIX}")({\n  ${timed}\n})`,
    },
  ];

  expect(findMistimedViewRoutes(sources)).toEqual([
    "view.timeline.tsx",
    "view.record.tsx",
  ]);
});
