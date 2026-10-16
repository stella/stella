import { expect, test } from "bun:test";
import fc from "fast-check";

import { MAX_EXCEPTION_CAUSE_DEPTH } from "@stll/errors/exception-cause-chain";
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

test("cause-chain shape distinguishes failures at the same declared path", () => {
  const error = new Error("failure");
  const wrapped = new Error("wrapper", { cause: error });
  expect(
    exceptionFingerprint(readEvidence(error), {
      fingerprintKey: "owner.execute",
      scope: { type: "handler", handlerId: "owner.execute" },
    }),
  ).not.toBe(
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

const errorClasses = {
  Error,
  TypeError,
  ReferenceError,
  RangeError,
  SyntaxError,
};
const errorClassArbitrary = fc.constantFrom(
  "Error",
  "TypeError",
  "ReferenceError",
  "RangeError",
  "SyntaxError",
);

const locatedChain = (
  classes: (keyof typeof errorClasses)[],
  location: { line: number; chunk: string },
) => {
  let cause: Error | undefined;
  for (const name of classes.toReversed()) {
    const error = new errorClasses[name]("failure", { cause });
    error.stack = `${name}: failure\n    at owner (/app/${location.chunk}.js:${location.line}:51)`;
    cause = error;
  }
  return cause;
};

const locatedSandboxChain = (
  reasons: SandboxError["reason"][],
  location: { line: number; chunk: string },
) => {
  let cause: SandboxError | undefined;
  for (const reason of reasons.toReversed()) {
    const error = new SandboxError({ message: "failure", reason, cause });
    error.stack = `SandboxError: failure\n    at owner (/app/${location.chunk}.js:${location.line}:51)`;
    cause = error;
  }
  return cause;
};

test("same-class nested reasons retain their cause-chain positions", () => {
  const options = {
    fingerprintKey: "sandbox.execute",
    scope: { type: "handler", handlerId: "sandbox.execute" },
  } as const;
  const first = readEvidence(
    locatedSandboxChain(["runtime", "timeout"], { line: 10, chunk: "before" }),
  );
  const reversed = readEvidence(
    locatedSandboxChain(["timeout", "runtime"], { line: 10, chunk: "before" }),
  );
  expect(first.nodes.map((node) => node.tag)).toEqual(
    reversed.nodes.map((node) => node.tag),
  );
  expect(first.nodes.map((node) => node.discriminators)).not.toEqual(
    reversed.nodes.map((node) => node.discriminators),
  );
  expect(exceptionFingerprint(first, options)).not.toBe(
    exceptionFingerprint(reversed, options),
  );
});

test("scope, cause class, or discriminator positions survive line shifts and rebuilds", () => {
  assertProperty(
    "scope, cause class, or discriminator positions survive line shifts and rebuilds",
    fc.property(
      scopeArbitrary,
      scopeArbitrary,
      fc.array(errorClassArbitrary, {
        minLength: 1,
        maxLength: MAX_EXCEPTION_CAUSE_DEPTH,
      }),
      fc.nat(),
      errorClassArbitrary,
      fc.constantFrom(
        "scope",
        "cause",
        "both",
        "discriminator",
        "swapped-discriminators",
      ),
      fc.nat({ max: 1_000_000 }),
      fc.uuid(),
      (
        left,
        right,
        classes,
        position,
        replacement,
        difference,
        shift,
        chunk,
      ) => {
        fc.pre(JSON.stringify(left) !== JSON.stringify(right));
        fc.pre(difference !== "swapped-discriminators" || classes.length > 1);
        const changedIndex = position % classes.length;
        fc.pre(classes.at(changedIndex) !== replacement);
        const otherClasses = classes.map((name, index) =>
          (difference === "cause" || difference === "both") &&
          index === changedIndex
            ? replacement
            : name,
        );
        const otherScope =
          difference === "scope" || difference === "both" ? right : left;
        const reasons = classes.map((_, index) =>
          index === changedIndex ? "timeout" : "runtime",
        );
        const otherReasons = reasons.map((reason, index) => {
          if (difference === "discriminator" && index === changedIndex) {
            return "transpile";
          }
          if (difference === "swapped-discriminators") {
            if (index === changedIndex) {
              return "runtime";
            }
            if (index === (changedIndex + 1) % classes.length) {
              return "timeout";
            }
          }
          return reason;
        });
        const discriminatorDifference =
          difference === "discriminator" ||
          difference === "swapped-discriminators";
        const evidence = readEvidence(
          discriminatorDifference
            ? locatedSandboxChain(reasons, { line: 10, chunk: "before" })
            : locatedChain(classes, { line: 10, chunk: "before" }),
        );
        const other = readEvidence(
          discriminatorDifference
            ? locatedSandboxChain(otherReasons, { line: 10, chunk: "before" })
            : locatedChain(otherClasses, { line: 10, chunk: "before" }),
        );
        const moved = readEvidence(
          discriminatorDifference
            ? locatedSandboxChain(reasons, { line: 11 + shift, chunk })
            : locatedChain(classes, { line: 11 + shift, chunk }),
        );
        const fingerprintKey = "shared.reportFailure";
        const first = exceptionFingerprint(evidence, {
          fingerprintKey,
          scope: left,
        });
        expect(first).not.toBe(
          exceptionFingerprint(other, { fingerprintKey, scope: otherScope }),
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
          exceptionFingerprint(other, {
            fingerprintKey,
            scope: helperScope,
            inheritedScopes: [otherScope],
          }),
        );
      },
    ),
  );
});
