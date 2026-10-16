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
      expect(
        exceptionFingerprint(before, {
          fingerprintKey: "owner.execute",
          scope: { type: "handler", handlerId: "owner.execute" },
        }),
      ).toBe(
        exceptionFingerprint(after, {
          fingerprintKey: "owner.execute",
          scope: { type: "handler", handlerId: "owner.execute" },
        }),
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
      expect(
        exceptionFingerprint(evidence, {
          fingerprintKey: `owner.${left}`,
          scope: { type: "handler", handlerId: `owner.${left}` },
        }),
      ).not.toBe(
        exceptionFingerprint(evidence, {
          fingerprintKey: `owner.${right}`,
          scope: { type: "handler", handlerId: `owner.${right}` },
        }),
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
          {
            fingerprintKey: "sandbox.execute",
            scope: { type: "handler", handlerId: "sandbox.execute" },
          },
        );
      expect(fingerprint(reason) === fingerprint(other)).toBe(reason === other);
    }
  }
});

test("unclassified cause wrappers do not change a declared failure path", () => {
  const error = new Error("failure");
  const wrapped = new Error("wrapper", { cause: error });
  expect(
    exceptionFingerprint(readEvidence(error), {
      fingerprintKey: "owner.execute",
      scope: { type: "handler", handlerId: "owner.execute" },
    }),
  ).toBe(
    exceptionFingerprint(readEvidence(wrapped), {
      fingerprintKey: "owner.execute",
      scope: { type: "handler", handlerId: "owner.execute" },
    }),
  );
});

const scopeArbitrary = fc.oneof(
  fc.record({
    type: fc.constant("request" as const),
    method: fc.constantFrom("GET", "POST"),
    routeTemplate: fc.uuid().map((id) => `/route-${id}/:entityId`),
  }),
  fc.record({ type: fc.constant("handler" as const), handlerId: fc.uuid() }),
  fc.record({
    type: fc.constant("job" as const),
    jobId: fc.uuid(),
    task: fc.uuid(),
  }),
  fc.record({ type: fc.constant("ingestion" as const), adapterKey: fc.uuid() }),
);

test("distinct execution scopes stay distinct across line shifts and rebuilds", () => {
  assertProperty(
    "distinct execution scopes stay distinct across line shifts and rebuilds",
    fc.property(
      scopeArbitrary,
      scopeArbitrary,
      fc.nat(),
      fc.uuid(),
      (left, right, shift, chunk) => {
        fc.pre(JSON.stringify(left) !== JSON.stringify(right));
        const evidence = readEvidence(
          Object.assign(locatedError(10, "before"), { code: "EIO" }),
        );
        const moved = readEvidence(
          Object.assign(locatedError(11 + shift, chunk), { code: "EIO" }),
        );
        const fingerprintKey = "shared.reportFailure";
        const first = exceptionFingerprint(evidence, {
          fingerprintKey,
          scope: left,
        });
        expect(first).not.toBe(
          exceptionFingerprint(evidence, { fingerprintKey, scope: right }),
        );
        expect(first).toBe(
          exceptionFingerprint(moved, { fingerprintKey, scope: left }),
        );
        const helperScope = {
          type: "handler",
          handlerId: "shared.reportFailure",
        } as const;
        expect(
          exceptionFingerprint(evidence, {
            fingerprintKey,
            scope: helperScope,
            inheritedScopes: [left],
          }),
        ).not.toBe(
          exceptionFingerprint(evidence, {
            fingerprintKey,
            scope: helperScope,
            inheritedScopes: [right],
          }),
        );
      },
    ),
  );
});
