import { expect, test } from "bun:test";
import ts from "typescript6";

import {
  declaredAppFrameScope,
  readDockedChatHosts,
  renderedImports,
} from "../helpers/docked-chat-hosts";

test.each(["member", "knowledge", "none"])(
  "reads declared %s scope independently of route names",
  (scope) => {
    const source = ts.createSourceFile(
      "renamed-route.tsx",
      `import { APP_FRAME_SCOPE as scope } from "@/routes/-app-frame-scope";
export const Route = createFileRoute("/unrelated-name")({ staticData: { appFrame: scope.${scope} } });`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    expect(declaredAppFrameScope(source)).toBe(scope);
  },
);

test("absent metadata inherits while unsupported metadata fails", () => {
  const parse = (source: string) =>
    ts.createSourceFile(
      "route.tsx",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
  expect(
    declaredAppFrameScope(
      parse('export const Route = createFileRoute("/_protected")({});'),
    ),
  ).toBeUndefined();
  expect(() =>
    declaredAppFrameScope(
      parse("const value = { staticData: { appFrame: arbitrary } };"),
    ),
  ).toThrow("Unsupported appFrame metadata");
});

test("docked chat census includes reader and inspector hosts but excludes non-page endpoints", () => {
  const { hosts, providerSources } = readDockedChatHosts();
  expect(providerSources.length).toBeGreaterThan(0);
  expect(new Set(hosts.map(({ template }) => template)).size).toBe(
    hosts.length,
  );
  expect(hosts.some(({ surfaces }) => surfaces.includes("reader"))).toBe(true);
  expect(hosts.some(({ surfaces }) => surfaces.includes("template"))).toBe(
    true,
  );
  expect(
    hosts.some(
      ({ template, surfaces }) =>
        template === "/chat" && surfaces.includes("inspector"),
    ),
  ).toBe(true);
  for (const template of [
    "/law/cases/research",
    "/law/cases/research/$tableId",
  ]) {
    expect(
      hosts.find((host) => host.template === template)?.surfaces,
    ).toContain("inspector");
  }
  expect(
    hosts.some(
      ({ template }) =>
        template.startsWith("/auth") ||
        template.includes("sitemap") ||
        template.endsWith("/download"),
    ),
  ).toBe(false);
});

test("docked chat census follows the frame a route's parent layout selects", () => {
  const { hosts } = readDockedChatHosts();
  // Account settings and organization admin share the app frame, and with it
  // the docked inspector.
  for (const template of [
    "/settings/account/profile",
    "/admin/general",
    "/admin/members",
  ]) {
    expect(
      hosts.find((host) => host.template === template)?.surfaces,
    ).toContain("inspector");
  }
});

test("a preview-only PDF viewer is not followed into its docked chat reader", () => {
  const imports = (mode: string) =>
    renderedImports(
      ts.createSourceFile(
        "preview.tsx",
        `import { PeekPdfViewer } from "@/components/pdf/peek/peek-pdf-viewer";
export const Preview = () => <PeekPdfViewer interactionMode="${mode}" />;`,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      ),
    );
  expect(imports("preview-only")).toEqual([]);
  expect(imports("with-ai")).toEqual(["@/components/pdf/peek/peek-pdf-viewer"]);
});
