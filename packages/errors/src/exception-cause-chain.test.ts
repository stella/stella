import { expect, test } from "bun:test";

import {
  exceptionCauseChainIdentity,
  exceptionCauseFieldsIdentity,
  MAX_EXCEPTION_CAUSE_DEPTH,
} from "./exception-cause-chain";

type ClassNode = { type: string; cause?: ClassNode };

const readNode = (node: ClassNode) => ({ type: node.type, cause: node.cause });

test("cause-chain identity retains order and repeated classes", () => {
  const root: ClassNode = {
    type: "UnhandledException",
    cause: {
      type: "Error",
      cause: { type: "Error", cause: { type: "TypeError" } },
    },
  };
  expect(exceptionCauseChainIdentity({ root, readNode })).toEqual([
    "UnhandledException",
    "Error",
    "Error",
    "TypeError",
  ]);
});

test("cause-chain identity stops cycles without reading messages or positions", () => {
  const root: ClassNode = { type: "UnhandledException" };
  const cause: ClassNode = { type: "TypeError", cause: root };
  root.cause = cause;
  let contentReads = 0;
  const readContent = () => {
    contentReads += 1;
    return "private";
  };
  for (const node of [root, cause]) {
    for (const key of ["message", "stack", "line", "column"]) {
      Object.defineProperty(node, key, {
        get: readContent,
      });
    }
  }
  expect(exceptionCauseChainIdentity({ root, readNode })).toEqual([
    "UnhandledException",
    "TypeError",
  ]);
  expect(contentReads).toBe(0);
});

test("cause-chain identity bounds readers that produce endless distinct nodes", () => {
  let reads = 0;
  const identity = exceptionCauseChainIdentity({
    root: 0,
    readNode: (node) => {
      reads += 1;
      return { type: "Error", cause: node + 1 };
    },
  });
  expect(identity).toHaveLength(MAX_EXCEPTION_CAUSE_DEPTH);
  expect(reads).toBe(MAX_EXCEPTION_CAUSE_DEPTH);
});

test("cause-chain identity preserves the readable prefix when a reader fails", () => {
  expect(
    exceptionCauseChainIdentity({
      root: 0,
      readNode: (node) => {
        if (node === 1) {
          throw new TypeError("unreadable class");
        }
        return { type: "Error", cause: 1 };
      },
    }),
  ).toEqual(["Error", "UnknownError"]);
});

test("cause-chain identity excludes non-class text and handles absent errors", () => {
  expect(exceptionCauseChainIdentity({ root: undefined, readNode })).toEqual([
    "UnknownError",
  ]);
  expect(
    exceptionCauseChainIdentity({
      root: { type: "Error: secret /file.js:3:4" },
      readNode,
    }),
  ).toEqual(["UnknownError"]);
});

test("finite classifications distinguish every repeated-class cause ordering", () => {
  for (let depth = 1; depth <= MAX_EXCEPTION_CAUSE_DEPTH; depth += 1) {
    const fingerprints = new Set<string>();
    const combinationCount = 2 ** depth;
    for (
      let combination = 0;
      combination < combinationCount;
      combination += 1
    ) {
      const nodes = Array.from({ length: depth }, (_, index) => ({
        type: "ClassifiedError",
        fields: {
          reason:
            Math.floor(combination / 2 ** index) % 2 === 0
              ? "decode"
              : "encode",
          stage: "parse",
        },
      }));
      const identity = exceptionCauseFieldsIdentity(nodes);
      expect(Object.keys(identity)).toHaveLength(depth * 2);
      fingerprints.add(JSON.stringify(identity));
      expect(
        exceptionCauseFieldsIdentity(
          nodes.map((node) => ({
            type: node.type,
            fields: Object.fromEntries(
              Object.entries(node.fields).toReversed(),
            ),
          })),
        ),
      ).toEqual(identity);
    }
    expect(fingerprints.size).toBe(combinationCount);
  }
});
