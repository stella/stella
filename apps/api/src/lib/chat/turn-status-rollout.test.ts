import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { CHAT_TURN_HANDED_OVER_ROLLOUT } from "./turn-status";

const API_SOURCE = path.resolve(import.meta.dir, "../..");
const REPOSITORY = path.resolve(API_SOURCE, "../../..");
/** The state planner defines the transition; it writes nothing. */
const PLANNER = path.join(API_SOURCE, "handlers/chat/chat-turn-state.ts");
/** A planned `hand-over` transition: the only way a turn becomes handed over. */
const HAND_OVER_TRANSITION = /type:\s*"hand-over"/u;

const releaseParts = (release: string): [number, number, number] => {
  const parts = release.trim().split(".").map(Number);
  const [major, minor, patch] = parts;
  return parts.length === 3 &&
    major !== undefined &&
    minor !== undefined &&
    patch !== undefined &&
    parts.every(Number.isInteger)
    ? [major, minor, patch]
    : panic(`Not a release: ${release}`);
};

/** Whether release `a` is `b` or later. */
const atLeast = (a: string, b: string): boolean => {
  const [left, right] = [releaseParts(a), releaseParts(b)];
  for (const index of [0, 1, 2] as const) {
    if (left[index] !== right[index]) {
      return left[index] > right[index];
    }
  }
  return true;
};

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "tests" ? [] : sourceFiles(file);
    }
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)
      ? [file]
      : [];
  });

test("no task writes handed-over before every task of an earlier release reads and adopts it", () => {
  const writers = sourceFiles(API_SOURCE).filter(
    (file) =>
      file !== PLANNER &&
      HAND_OVER_TRANSITION.test(readFileSync(file, "utf-8")),
  );
  if (writers.length === 0) {
    return;
  }
  const cut = readFileSync(path.join(REPOSITORY, "VERSION"), "utf-8").trim();
  const { adopters, readers } = CHAT_TURN_HANDED_OVER_ROLLOUT;
  const named = writers.map((file) => repoRelativePath(REPOSITORY, file));
  expect({
    adoptersCut: adopters !== null && atLeast(cut, adopters),
    readersCut: atLeast(cut, readers),
    writers: named,
  }).toEqual({ adoptersCut: true, readersCut: true, writers: named });
});

test("the adopters ship no earlier than the readers", () => {
  const { adopters, readers } = CHAT_TURN_HANDED_OVER_ROLLOUT;
  expect(adopters === null || atLeast(adopters, readers)).toBe(true);
});
