import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { scopeBaseline, validateBaselineFile } from "./network-baseline-scope";

const entry = (depth: number) => ({ depth, requests: [`GET /${depth}`] });

const routeTree = `
import { Route as IndexRouteImport } from './routes/index'
import { Route as ChatRouteImport } from './routes/_protected.chat/index'
import { Route as SettingsRouteImport } from './routes/_protected.settings/index'
declare module '@tanstack/react-router' {
  interface FileRoutesByPath {
    '/': { fullPath: '/'; preLoaderRoute: typeof IndexRouteImport }
    '/chat': { fullPath: '/chat'; preLoaderRoute: typeof ChatRouteImport }
    '/settings': { fullPath: '/settings'; preLoaderRoute: typeof SettingsRouteImport }
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
      }),
    ).toEqual({
      "/": entry(1),
      "/chat": entry(22),
      "/new-route": entry(44),
      "/settings": entry(3),
    });
  });

  test("--all permits every recorded entry while retaining recorded omissions", () => {
    const base = { "/": entry(1), "/settings": entry(3) };
    const recorded = { "/": entry(11) };
    expect(
      scopeBaseline({ base, recorded, changedPaths: [], routeTree, all: true }),
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
      expect(() => validateBaselineFile(oversizedPath)).toThrow("exceeds");
      symlinkSync(validPath, symlinkPath);
      expect(() => validateBaselineFile(symlinkPath)).toThrow(
        "must not be a symlink",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
