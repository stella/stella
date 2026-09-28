import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { scopeBaseline, validateBaselineFile } from "./network-baseline-scope";

const entry = (depth: number) => ({ depth, requests: [`GET /${depth}`] });

const routeTree = `
import { Route as rootRouteImport } from './routes/__root'
import { Route as IndexRouteImport } from './routes/index'
import { Route as ProtectedRouteImport } from './routes/_protected'
import { Route as ChatRouteRouteImport } from './routes/_protected.chat/route'
import { Route as ChatRouteImport } from './routes/_protected.chat/index'
import { Route as SettingsRouteImport } from './routes/_protected.settings/index'
declare module '@tanstack/react-router' {
  interface FileRoutesByPath {
    '/': {
      id: '/'
      path: '/'
      fullPath: '/'
      preLoaderRoute: typeof IndexRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/_protected': {
      id: '/_protected'
      path: ''
      fullPath: '/'
      preLoaderRoute: typeof ProtectedRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/_protected/chat': {
      id: '/_protected/chat'
      path: '/chat'
      fullPath: '/chat'
      preLoaderRoute: typeof ChatRouteRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/chat/': {
      id: '/_protected/chat/'
      path: '/'
      fullPath: '/chat/'
      preLoaderRoute: typeof ChatRouteImport
      parentRoute: typeof ChatRouteRoute
    }
    '/settings': {
      id: '/settings'
      path: '/settings'
      fullPath: '/settings'
      preLoaderRoute: typeof SettingsRouteImport
      parentRoute: typeof ProtectedRoute
    }
  }
}`;

describe("network baseline scope", () => {
  test("keeps new and touched routes, restores all other base entries", () => {
    const base = { "/": entry(1), "/chat": entry(2), "/settings": entry(3) };
    const recorded = {
      "/": entry(11),
      "/chat": entry(22),
      "/new-route": entry(44),
    };

    expect(
      scopeBaseline({
        base,
        recorded,
        changedPaths: ["apps/web/src/routes/_protected.chat/index.tsx"],
        routeTree,
        baseRouteTree: routeTree,
      }),
    ).toEqual({
      "/": entry(1),
      "/chat": entry(22),
      "/settings": entry(3),
    });
  });

  test("accepts index and redirect target keys with a trailing slash in the tree", () => {
    const base = { "/chat": entry(1), "/chat target": entry(2) };
    const recorded = { "/chat": entry(11), "/chat target": entry(22) };
    expect(
      scopeBaseline({
        base,
        recorded,
        changedPaths: ["apps/web/src/routes/_protected.chat/index.tsx"],
        baseRouteTree: routeTree,
        routeTree,
      }),
    ).toEqual(recorded);
  });

  test("a changed pathless layout marks descendants", () => {
    const base = { "/chat": entry(1), "/settings": entry(2) };
    const recorded = { "/chat": entry(11), "/settings": entry(22) };
    expect(
      scopeBaseline({
        base,
        recorded,
        changedPaths: ["apps/web/src/routes/_protected.tsx"],
        baseRouteTree: routeTree,
        routeTree,
      }),
    ).toEqual(recorded);
  });

  test("omits a deleted route present only in the base tree", () => {
    const headRouteTree = routeTree.replace(
      / {4}'\/_protected\/chat\/': \{[\s\S]*?^ {4}\}\n/gmu,
      "",
    );
    expect(
      scopeBaseline({
        base: { "/chat": entry(1), "/settings": entry(2) },
        recorded: { "/settings": entry(22) },
        changedPaths: ["apps/web/src/routes/_protected.chat/index.tsx"],
        baseRouteTree: routeTree,
        routeTree: headRouteTree,
      }),
    ).toEqual({ "/settings": entry(2) });
  });

  test("--all permits every recorded entry while retaining recorded omissions", () => {
    const base = { "/": entry(1), "/settings": entry(3) };
    const recorded = { "/": entry(11) };
    expect(
      scopeBaseline({
        base,
        recorded,
        changedPaths: [],
        baseRouteTree: routeTree,
        routeTree,
        all: true,
      }),
    ).toEqual(recorded);
  });

  test("validates schema and rejects oversized files and symlinks", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "network-baseline-"));
    const validPath = path.join(directory, "baseline.json");
    const oversizedPath = path.join(directory, "oversized.json");
    const symlinkPath = path.join(directory, "linked.json");
    try {
      writeFileSync(validPath, JSON.stringify({ "/": entry(1) }));
      expect(validateBaselineFile(validPath)).toEqual({ "/": entry(1) });
      writeFileSync(oversizedPath, " ".repeat(5 * 1024 * 1024 + 1));
      symlinkSync(validPath, symlinkPath);
      for (const [file, message] of [
        [oversizedPath, "exceeds"],
        [symlinkPath, "must not be a symlink"],
      ]) {
        const result = Bun.spawnSync([
          "bun",
          "scripts/network-baseline-scope.ts",
          "validate",
          file,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain(message);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
