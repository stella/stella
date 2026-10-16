import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { SandboxError } from "@/api/lib/errors/tagged-errors";

import { exceptionFingerprint } from "./exception-fingerprint";
import { readEvidence } from "./failure-evidence";

const locatedError = (line: number, chunk: string) => {
  const error = new Error("failure");
  error.stack = `Error: failure\n    at owner (/app/${chunk}.js:${line}:51)`;
  return error;
};

test("exception identity survives line insertion and bundle renaming", () => {
  assertProperty(
    "exception identity survives line insertion and bundle renaming",
    fc.property(fc.nat({ max: 1_000_000 }), fc.uuid(), (offset, chunk) => {
      const before = readEvidence(locatedError(766, "chat-client"));
      const after = readEvidence(locatedError(767 + offset, chunk));
      expect(before.nodes.at(0)?.frame).not.toEqual(after.nodes.at(0)?.frame);
      expect(exceptionFingerprint(before, "owner.execute")).toBe(
        exceptionFingerprint(after, "owner.execute"),
      );
    }),
  );
});

test("distinct frameless paths retain distinct identities", () => {
  assertProperty(
    "distinct frameless paths retain distinct identities",
    fc.property(fc.uuid(), fc.uuid(), (left, right) => {
      fc.pre(left !== right);
      const error = new Error("failure");
      error.stack = undefined;
      const evidence = readEvidence(error);
      expect(exceptionFingerprint(evidence, `owner.${left}`)).not.toBe(
        exceptionFingerprint(evidence, `owner.${right}`),
      );
    }),
  );
});

test("typed reasons distinguish failures at the same owner", () => {
  const reasons = ["runtime", "timeout", "transpile"] as const;
  for (const reason of reasons) {
    for (const other of reasons) {
      const fingerprint = (value: (typeof reasons)[number]) =>
        exceptionFingerprint(
          readEvidence(new SandboxError({ message: "failure", reason: value })),
          "sandbox.execute",
        );
      expect(fingerprint(reason) === fingerprint(other)).toBe(reason === other);
    }
  }
});

test("unclassified cause wrappers do not change a declared failure path", () => {
  const error = new Error("failure");
  const wrapped = new Error("wrapper", { cause: error });
  expect(exceptionFingerprint(readEvidence(error), "owner.execute")).toBe(
    exceptionFingerprint(readEvidence(wrapped), "owner.execute"),
  );
});
