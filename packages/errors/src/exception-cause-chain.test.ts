import { expect, test } from "bun:test";

import {
  exceptionCauseChainIdentity,
  exceptionDiscriminatorIdentity,
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

test("discriminator identity distinguishes equal bags at different cause positions", () => {
  const forward = [
    { type: "SandboxError", discriminators: { reason: "runtime" } },
    { type: "SandboxError", discriminators: { reason: "timeout" } },
  ];
  expect(exceptionDiscriminatorIdentity(forward)).toEqual([
    [0, "SandboxError", "reason", "runtime"],
    [1, "SandboxError", "reason", "timeout"],
  ]);
  expect(exceptionDiscriminatorIdentity(forward)).not.toEqual(
    exceptionDiscriminatorIdentity(forward.toReversed()),
  );
});

test("discriminator identity keeps positions of nodes without declared fields", () => {
  expect(
    exceptionDiscriminatorIdentity([
      { type: "Error" },
      { type: "SandboxError", discriminators: { reason: "timeout" } },
    ]),
  ).toEqual([[1, "SandboxError", "reason", "timeout"]]);
});

test("discriminator identity canonicalizes field order within each node", () => {
  expect(
    exceptionDiscriminatorIdentity([
      {
        type: "SandboxError",
        discriminators: { reason: "runtime", phase: "execute" },
      },
    ]),
  ).toEqual(
    exceptionDiscriminatorIdentity([
      {
        type: "SandboxError",
        discriminators: { phase: "execute", reason: "runtime" },
      },
    ]),
  );
});

test("discriminator identity never reads fields beyond the cause depth bound", () => {
  let tailReads = 0;
  const tail = {
    type: "SandboxError",
    get discriminators() {
      tailReads += 1;
      return { reason: "timeout" };
    },
  };
  const nodes = Array.from({ length: MAX_EXCEPTION_CAUSE_DEPTH }, () => ({
    type: "Error",
  }));
  expect(exceptionDiscriminatorIdentity([...nodes, tail])).toEqual([]);
  expect(tailReads).toBe(0);
});
