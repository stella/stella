import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (
  source: string,
  sourcePath = "apps/web/src/lib/workspaces/reveal.ts",
) =>
  await lintSingleRule("no-route-identity-from-path", source, { sourcePath });

const linesOf = (source: string) =>
  Array.from({ length: source.split("\n").length }, (_, index) => index + 1);

describe("matter page from the URL path", () => {
  test("rejects the removed helpers, as written before their removal", async () => {
    const source = [
      "export const getCurrentWorkspaceViewId = (pathname: string, workspaceId: string) => {",
      `  const prefix = \`/workspaces/\${workspaceId}/\`;`,
      "  return pathname.slice(prefix.length).split('/').at(0) ?? null;",
      "};",
      "const DOCUMENT_ROUTE_SUFFIX = '/document';",
      "export const isWorkspaceDocumentRoutePath = (pathname: string) =>",
      "  pathname.endsWith(DOCUMENT_ROUTE_SUFFIX);",
    ].join("\n");
    expect(await lint(source)).toEqual([1, 3, 6, 7]);
  });

  test("rejects each read or test of a path that spells a matter route", async () => {
    // One flagged form per line; each function spells the route itself.
    const flagged = [
      `const a = (workspaceId: string) => location.pathname.slice(\`/workspaces/\${workspaceId}/\`.length);`,
      "const b = (pathname: string) => pathname.match(/^\\/workspaces\\/[^/]+\\/([^/]+)/u)?.[1];",
      "const c = (router) => /\\/workspaces\\/([^/]+)/u.exec(router.state.location.pathname);",
      "const d = () => window.location.pathname.replace('/workspaces/', '');",
      "const e = ({ pathname }) => { const [, root, , viewId] = pathname.split('/'); return root === 'workspaces' ? viewId : null; };",
      "const f = (url: URL) => url.pathname.substring(`/workspaces/`.length);",
      `const g = (workspaceId: string, pathname: string) => new RegExp(\`^/workspaces/\${workspaceId}/[^/]+/document(?:/|$)\`, 'u').test(pathname);`,
      "const h = (location: Location) => /^\\/workspaces\\/[^/]+\\/[^/]+\\/document/u.test(location.pathname);",
      "const i = (pathname: string) => pathname.startsWith('/workspaces/');",
      "const j = (pathname: string) => pathname.endsWith('/document');",
      "const k = (pathname: string) => pathname.includes('workspaces/');",
      "import { getCurrentWorkspaceViewId } from '@/lib/workspaces/reveal-navigation';",
      "import { isWorkspaceDocumentRoutePath } from '@/components/workspaces/entity-utils';",
    ].join("\n");
    expect(await lint(flagged)).toEqual(linesOf(flagged));
  });

  test("a route prefix in the module reaches every function under it", async () => {
    const source = [
      "const VIEW_PATH = /^\\/workspaces\\/[^/]+\\/([^/]+)/u;",
      "export const viewIdOf = (pathname: string) => VIEW_PATH.exec(pathname)?.[1];",
      "export const onView = (pathname: string) => VIEW_PATH.test(pathname);",
    ].join("\n");
    expect(await lint(source)).toEqual([2, 3]);
  });

  test("accepts route templates, API paths and paths outside matter routes", async () => {
    const accepted = [
      "const name = (url: URL) => url.pathname.split('/').at(-1);",
      "const route = { to: '/workspaces/$workspaceId/$viewId', id: location.pathname.slice(1) };",
      "const policy = { '/workspaces/': 'private', trimmed: location.pathname.replace(/\\/$/u, '') };",
      "const sibling = () => '/workspaces/';",
      "const other = (pathname: string) => pathname.split('/');",
      "const api = (pathname: string) => pathname.startsWith('/v1/workspaces/') && /^\\/v1\\/chat\\/threads\\/[^/]+$/u.test(pathname);",
      `const settings = (pathname: string, to: string) => pathname === to || pathname.startsWith(\`\${to}/\`);`,
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
