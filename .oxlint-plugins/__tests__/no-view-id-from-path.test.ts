import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (
  source: string,
  sourcePath = "apps/web/src/lib/workspaces/reveal.ts",
) => await lintSingleRule("no-view-id-from-path", source, { sourcePath });

const linesOf = (source: string) =>
  Array.from({ length: source.split("\n").length }, (_, index) => index + 1);

describe("view id from the URL path", () => {
  test("rejects the removed parser, as written before its removal", async () => {
    const source = [
      "export const getCurrentWorkspaceViewId = (pathname: string, workspaceId: string) => {",
      `  const prefix = \`/workspaces/\${workspaceId}/\`;`,
      "  return pathname.slice(prefix.length).split('/').at(0) ?? null;",
      "};",
    ].join("\n");
    expect(await lint(source)).toEqual([1, 3]);
  });

  test("rejects each segment read off a path that spells a matter route", async () => {
    // One flagged form per line; each function spells the route itself.
    const flagged = [
      `const a = (workspaceId: string) => location.pathname.slice(\`/workspaces/\${workspaceId}/\`.length);`,
      "const b = (pathname: string) => pathname.match(/^\\/workspaces\\/[^/]+\\/([^/]+)/u)?.[1];",
      "const c = (router) => /\\/workspaces\\/([^/]+)/u.exec(router.state.location.pathname);",
      "const d = () => window.location.pathname.replace('/workspaces/', '');",
      "const e = ({ pathname }) => { const [, root, , viewId] = pathname.split('/'); return root === 'workspaces' ? viewId : null; };",
      "const f = (url: URL) => url.pathname.substring(`/workspaces/`.length);",
      "import { getCurrentWorkspaceViewId } from '@/lib/workspaces/reveal-navigation';",
    ].join("\n");
    expect(await lint(flagged)).toEqual(linesOf(flagged));
  });

  test("a route prefix in the module reaches every function under it", async () => {
    const source = [
      "const VIEW_PATH = /^\\/workspaces\\/[^/]+\\/([^/]+)/u;",
      "export const viewIdOf = (pathname: string) => VIEW_PATH.exec(pathname)?.[1];",
    ].join("\n");
    expect(await lint(source)).toEqual([2]);
  });

  test("accepts route checks, route templates and paths outside matter routes", async () => {
    const accepted = [
      `const onDocument = (workspaceId: string, pathname: string) => new RegExp(\`^/workspaces/\${workspaceId}/[^/]+/document\`, 'u').test(pathname);`,
      "const isMatter = (pathname: string) => pathname.startsWith('/workspaces/');",
      "const name = (url: URL) => url.pathname.split('/').at(-1);",
      "const route = { to: '/workspaces/$workspaceId/$viewId', id: location.pathname.slice(1) };",
      "const policy = { '/workspaces/': 'private', trimmed: location.pathname.replace(/\\/$/u, '') };",
      "const sibling = () => '/workspaces/';",
      "const other = (pathname: string) => pathname.split('/');",
    ].join("\n");
    expect(await lint(accepted)).toEqual([]);
  });

  test("a module import naming the workspaces folder is not a route", async () => {
    const source = [
      "import { viewsOptions } from '@/lib/workspaces/queries/views';",
      "const load = () => import('@/lib/workspaces/queries');",
      "export const last = (pathname: string) => pathname.split('/').at(-1);",
      "export { viewsOptions, load };",
    ].join("\n");
    expect(await lint(source)).toEqual([]);
  });
});
