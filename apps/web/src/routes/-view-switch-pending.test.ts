import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { VIEW_SWITCH_PENDING } from "@/routes/-pending-view.logic";

// A view switch replaces the `$viewId` match, so every route under it is
// where the router decides how long the outgoing view stays on screen.
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

/** View-switch routes left on the router's default pending timing. */
const findLingeringViewRoutes = (sources: readonly RouteSource[]) =>
  sources
    .filter(isViewSwitchRoute)
    .filter(({ source }) =>
      REQUIRED_OPTIONS.some((option) => !source.includes(option)),
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
  expect(findLingeringViewRoutes(sources)).toEqual([]);
});

test("the check names a view route on the router's default timing", () => {
  const sources = [
    {
      file: "view.timeline.tsx",
      source: `createFileRoute(\n  "${VIEW_SWITCH_ROUTE_PREFIX}/timeline",\n)({ pendingComponent: TimelinePending })`,
    },
    {
      file: "lists.tsx",
      source: `createFileRoute("/_protected/workspaces/$workspaceId/lists")({})`,
    },
    {
      file: "view.route.tsx",
      source: `createFileRoute("${VIEW_SWITCH_ROUTE_PREFIX}")({\n  ${REQUIRED_OPTIONS.join("\n  ")}\n})`,
    },
  ];

  expect(findLingeringViewRoutes(sources)).toEqual(["view.timeline.tsx"]);
});
