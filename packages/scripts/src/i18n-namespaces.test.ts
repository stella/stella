import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildCatalogs,
  checkNamespaces,
  splitCatalogs,
} from "./i18n-namespaces";

const withTempI18n = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(tmpdir(), "i18n-namespaces-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("i18n-namespaces", () => {
  test("splits and rebuilds catalogs losslessly", async () => {
    await withTempI18n(async (dir) => {
      await mkdir(path.join(dir, "langs"), { recursive: true });
      await Bun.write(
        path.join(dir, "namespaces.json"),
        JSON.stringify(
          { billing: "billing", chat: "chat", common: "core" },
          null,
          2,
        ),
      );
      const en = {
        billing: { title: "Billing" },
        chat: { send: "Send" },
        common: { ok: "OK" },
      };
      const cs = {
        billing: { title: "Fakturace" },
        chat: { send: "Odeslat" },
        common: { ok: "OK" },
      };
      await Bun.write(
        path.join(dir, "langs/en.json"),
        `${JSON.stringify(en, null, 2)}\n`,
      );
      await Bun.write(
        path.join(dir, "langs/cs.json"),
        `${JSON.stringify(cs, null, 2)}\n`,
      );

      const splitResult = await splitCatalogs(dir);
      expect(splitResult).toEqual({ locales: 2, written: 6 });
      expect(await checkNamespaces(dir)).toEqual([]);

      // Rebuild is idempotent when content already matches
      const buildResult = await buildCatalogs(dir);
      expect(buildResult).toEqual({ locales: 2, written: 0 });

      // Remove built langs and verify full rebuild
      await rm(path.join(dir, "langs"), { recursive: true, force: true });
      const rebuilt = await buildCatalogs(dir);
      expect(rebuilt).toEqual({ locales: 2, written: 2 });
      expect(await Bun.file(path.join(dir, "langs/en.json")).json()).toEqual(
        en,
      );
      expect(await Bun.file(path.join(dir, "langs/cs.json")).json()).toEqual(
        cs,
      );
    });
  });

  test("checkNamespaces flags misplaced and duplicate namespaces", async () => {
    await withTempI18n(async (dir) => {
      await mkdir(path.join(dir, "namespaces/en"), { recursive: true });
      await Bun.write(
        path.join(dir, "namespaces.json"),
        JSON.stringify({ chat: "chat", common: "core" }, null, 2),
      );
      await Bun.write(
        path.join(dir, "namespaces/en/chat.json"),
        JSON.stringify({ chat: { a: "A" }, common: { b: "B" } }, null, 2),
      );
      await Bun.write(
        path.join(dir, "namespaces/en/core.json"),
        JSON.stringify({ common: { b: "B" } }, null, 2),
      );

      const errors = await checkNamespaces(dir);
      expect(errors.some((e) => e.includes("belongs in core.json"))).toBe(true);
      expect(
        errors.some((e) =>
          e.includes('duplicate top-level namespace "common"'),
        ),
      ).toBe(true);
    });
  });
});
