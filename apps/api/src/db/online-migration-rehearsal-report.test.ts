import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { parseOnlineRepairRehearsalReport } from "./online-migration-rehearsal-guard";
import type { OnlineRepairRehearsalRecord } from "./online-migration-rehearsal-guard";
import { prepareOnlineRepairRehearsalReport } from "./online-migration-rehearsal-report";

const records = [
  { type: "checked", name: "current", completion: "incomplete" },
  { type: "attempted", name: "current" },
] as const satisfies readonly OnlineRepairRehearsalRecord[];

const withDirectory = (work: (directory: string) => void) => {
  const directory = mkdtempSync(
    nodePath.join(tmpdir(), "stella-repair-report-"),
  );
  try {
    work(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("online repair report publication", () => {
  test("preparation creates no receipt; publication exposes one complete private file", () => {
    withDirectory((directory) => {
      const destination = nodePath.join(directory, "report.jsonl");
      const report = prepareOnlineRepairRehearsalReport(destination);
      expect(readdirSync(directory)).toEqual([]);
      report.publish(records);
      expect(readdirSync(directory)).toEqual(["report.jsonl"]);
      expect(
        parseOnlineRepairRehearsalReport(readFileSync(destination, "utf-8")),
      ).toEqual([...records]);
      expect(statSync(destination).mode % 0o1000).toBe(0o600);
      expect(() => report.publish(records)).toThrow("already exists");
    });
  });

  test("refuses all existing final paths, including dangling symlinks", () => {
    withDirectory((directory) => {
      const existing = nodePath.join(directory, "existing");
      const folder = nodePath.join(directory, "folder");
      const link = nodePath.join(directory, "link");
      const dangling = nodePath.join(directory, "dangling");
      writeFileSync(existing, "original");
      mkdirSync(folder);
      symlinkSync(existing, link);
      symlinkSync(nodePath.join(directory, "absent"), dangling);
      for (const destination of [existing, folder, link, dangling]) {
        expect(() => prepareOnlineRepairRehearsalReport(destination)).toThrow(
          "already exists",
        );
      }
      expect(readFileSync(existing, "utf-8")).toBe("original");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
      expect(readdirSync(directory).toSorted()).toEqual([
        "dangling",
        "existing",
        "folder",
        "link",
      ]);
    });
  });

  test("validates parent usability before any receipt is prepared", () => {
    withDirectory((directory) => {
      expect(() =>
        prepareOnlineRepairRehearsalReport(
          nodePath.join(directory, "missing", "report"),
        ),
      ).toThrow("ENOENT");
      const parentFile = nodePath.join(directory, "file");
      writeFileSync(parentFile, "file");
      expect(() =>
        prepareOnlineRepairRehearsalReport(nodePath.join(parentFile, "report")),
      ).toThrow(/ENOTDIR|parent must be a directory/u);
      expect(readdirSync(directory)).toEqual(["file"]);
    });
  });

  test("refuses a parent without write permission before staging", () => {
    withDirectory((directory) => {
      chmodSync(directory, 0o500);
      try {
        expect(() =>
          prepareOnlineRepairRehearsalReport(
            nodePath.join(directory, "report"),
          ),
        ).toThrow("EACCES");
        expect(readdirSync(directory)).toEqual([]);
      } finally {
        chmodSync(directory, 0o700);
      }
    });
  });

  test("a competing writer after preparation wins without overwrite", () => {
    withDirectory((directory) => {
      const destination = nodePath.join(directory, "report");
      const first = prepareOnlineRepairRehearsalReport(destination);
      const second = prepareOnlineRepairRehearsalReport(destination);
      first.publish(records);
      const original = readFileSync(destination, "utf-8");
      expect(() => second.publish(records)).toThrow("already exists");
      expect(readFileSync(destination, "utf-8")).toBe(original);
      expect(readdirSync(directory)).toEqual(["report"]);
    });
  });

  test("exclusive linking refuses a destination created after the final precheck", () => {
    withDirectory((directory) => {
      const destination = nodePath.join(directory, "report");
      const report = prepareOnlineRepairRehearsalReport(destination);
      const competingRecord = {
        type: "checked",
        get name() {
          writeFileSync(destination, "competing receipt", { flag: "wx" });
          return "current";
        },
        completion: "complete",
      } satisfies OnlineRepairRehearsalRecord;
      expect(() => report.publish([competingRecord])).toThrow("EEXIST");
      expect(readFileSync(destination, "utf-8")).toBe("competing receipt");
      expect(readdirSync(directory)).toEqual(["report"]);
    });
  });

  test("refuses a symlink introduced after preparation without touching its target", () => {
    withDirectory((directory) => {
      const destination = nodePath.join(directory, "report");
      const target = nodePath.join(directory, "target");
      const report = prepareOnlineRepairRehearsalReport(destination);
      writeFileSync(target, "original");
      symlinkSync(target, destination);
      expect(() => report.publish(records)).toThrow("already exists");
      expect(readFileSync(target, "utf-8")).toBe("original");
      expect(lstatSync(destination).isSymbolicLink()).toBe(true);
      expect(readdirSync(directory).toSorted()).toEqual(["report", "target"]);
    });
  });

  test("a failure while staging leaves no final or temporary receipt", () => {
    withDirectory((directory) => {
      const destination = nodePath.join(directory, "report");
      const report = prepareOnlineRepairRehearsalReport(destination);
      const failure = new TypeError("serialization failed");
      const brokenRecord = {
        type: "checked",
        get name(): string {
          throw failure;
        },
        completion: "complete",
      } satisfies OnlineRepairRehearsalRecord;
      expect(() => report.publish([brokenRecord])).toThrow(failure);
      expect(existsSync(destination)).toBe(false);
      expect(readdirSync(directory)).toEqual([]);
    });
  });

  test("a disappeared parent fails without publishing a receipt", () => {
    withDirectory((directory) => {
      const parent = nodePath.join(directory, "parent");
      mkdirSync(parent);
      const destination = nodePath.join(parent, "report");
      const report = prepareOnlineRepairRehearsalReport(destination);
      rmSync(parent, { recursive: true });
      expect(() => report.publish(records)).toThrow("ENOENT");
      expect(readdirSync(directory)).toEqual([]);
    });
  });
});
