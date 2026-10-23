import { panic, TaggedError } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import { ResponseConformanceError } from "@/api/lib/response-conformance-error";

export class ResponseConformanceTestError extends TaggedError(
  "ResponseConformanceTestError",
)<{
  message: string;
  violations: readonly Pick<
    ResponseConformanceError,
    "route" | "status" | "issuePath" | "contentType"
  >[];
}> {}

type ViolationSink = Map<string, ResponseConformanceError>;
type CapturedViolationScope = {
  status: "capturing" | "closed";
  violations: ViolationSink;
};
const capturedViolations = new AsyncLocalStorage<CapturedViolationScope>();
const defaultViolations: ViolationSink = new Map();
let lifecycle: "inactive" | "idle" | "running" | "overlapping" = "inactive";

const findConformanceViolation = (error: unknown) => {
  const seen = new Set<object>();
  let current = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    if (ResponseConformanceError.is(current)) {
      return current;
    }
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
};

/** Records only typed contract defects; observers still throw their original error. */
export const recordResponseConformanceViolation = (error: unknown): void => {
  const violation = findConformanceViolation(error);
  if (violation === undefined) {
    return;
  }
  const scope = capturedViolations.getStore();
  if (scope?.status !== "capturing" && lifecycle === "inactive") {
    return;
  }
  const sink =
    scope?.status === "capturing" ? scope.violations : defaultViolations;
  const key = JSON.stringify([
    violation.route,
    violation.status,
    violation.issuePath,
  ]);
  const existing = sink.get(key);
  if (
    existing?.contentType !== undefined &&
    violation.contentType === undefined
  ) {
    return;
  }
  sink.set(key, violation);
};

/** Explicit negative fixtures own their violations without weakening the process sink. */
export const captureResponseConformanceViolations = async <T>(
  operation: () => T | Promise<T>,
) => {
  const scope: CapturedViolationScope = {
    status: "capturing",
    violations: new Map(),
  };
  try {
    const value = await capturedViolations.run(scope, operation);
    return { value, violations: [...scope.violations.values()] };
  } finally {
    // Detached work settling after the explicit scope belongs to the default sink.
    scope.status = "closed";
  }
};

const serialFailure = () =>
  panic("Response conformance test hooks require serial tests");

const drainDefaultViolations = (): void => {
  const violations = [...defaultViolations.values()].map(
    ({ route, status, issuePath, contentType }) => ({
      route,
      status,
      issuePath,
      ...(contentType === undefined ? {} : { contentType }),
    }),
  );
  defaultViolations.clear();
  if (violations.length === 0) {
    return;
  }
  const message = violations
    .map(
      ({ route, status, issuePath, contentType }) =>
        `Response conformance failed: ${route} status ${status} at ${issuePath}${
          contentType === undefined ? "" : ` (content-type: ${contentType})`
        }`,
    )
    .join("\n");
  throw new ResponseConformanceTestError({ message, violations });
};

type ResponseConformanceTestHooks = {
  beforeEach: (callback: () => void) => void;
  afterEach: (callback: () => void) => void;
  afterAll: (callback: () => void) => void;
};

/** Runner hooks are injected so generators can import this module without bun:test. */
export const installResponseConformanceTestHooks = ({
  beforeEach,
  afterEach,
  afterAll,
}: ResponseConformanceTestHooks): void => {
  if (lifecycle !== "inactive") {
    return;
  }
  if (
    process.argv.some(
      (argument) =>
        argument === "--concurrent" || argument.startsWith("--concurrent="),
    )
  ) {
    serialFailure();
  }
  lifecycle = "idle";
  beforeEach(() => {
    if (lifecycle !== "idle") {
      lifecycle = "overlapping";
      serialFailure();
    }
    // Retain defects from beforeAll or work that settled after the previous test.
    lifecycle = "running";
  });
  afterEach(() => {
    if (lifecycle !== "running") {
      serialFailure();
    }
    lifecycle = "idle";
    drainDefaultViolations();
  });
  afterAll(() => {
    const previous = lifecycle;
    lifecycle = "idle";
    drainDefaultViolations();
    if (previous === "overlapping") {
      serialFailure();
    }
  });
};
