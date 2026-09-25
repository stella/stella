import { describe, expect, test } from "bun:test";

import {
  classifyFailure,
  declareFailureClass,
  FAILURE_GRADES,
  FAILURE_REASON_GRADE,
  isFailureReason,
  MISCONFIGURATION_REASONS,
  readFailureBrand,
} from "./failure";

describe("failure vocabulary", () => {
  test("every reason maps to one of the four grades", () => {
    const grades = new Set<string>(FAILURE_GRADES);
    for (const grade of Object.values(FAILURE_REASON_GRADE)) {
      expect(grades.has(grade)).toBe(true);
    }
  });

  test("every grade is reachable from some reason", () => {
    const reached = new Set<string>(Object.values(FAILURE_REASON_GRADE));
    expect([...reached].toSorted()).toEqual([...FAILURE_GRADES].toSorted());
  });

  test("misconfiguration reasons stay out of the paging grade", () => {
    // A misconfiguration is answered to an administrator, not to on-call; a
    // defect grade here would page for a settings problem.
    expect(
      MISCONFIGURATION_REASONS.map((reason) => [
        reason,
        FAILURE_REASON_GRADE[reason],
      ]),
    ).toEqual([
      ["provider_billing", "anticipated"],
      ["provider_credentials_rejected", "anticipated"],
      ["model_unavailable", "anticipated"],
      ["credentials_token_unreadable", "anticipated"],
      ["pg_auth_failed", "defect"],
    ]);
  });

  test("recognises reasons by own key only", () => {
    expect(isFailureReason("quota_exhausted")).toBe(true);
    expect(isFailureReason("toString")).toBe(false);
    expect(isFailureReason("__proto__")).toBe(false);
    expect(isFailureReason(42)).toBe(false);
  });
});

describe("failure classification brand", () => {
  class DeclaredFailureError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "DeclaredFailureError";
    }
  }
  class DerivedFailureError extends DeclaredFailureError {
    constructor(message: string) {
      super(message);
      this.name = "DerivedFailureError";
    }
  }
  class ComputedFailureError extends Error {
    readonly retryable: boolean;
    constructor(retryable: boolean) {
      super("computed");
      this.name = "ComputedFailureError";
      this.retryable = retryable;
    }
  }
  declareFailureClass(DeclaredFailureError, "rls_denied");
  declareFailureClass(ComputedFailureError, (instance) =>
    instance.retryable ? "upstream_unavailable" : "unclassified",
  );

  test("a declared class classifies its instances and subclasses", () => {
    expect(readFailureBrand(new DeclaredFailureError("x"))).toEqual({
      reason: "rls_denied",
      source: "class",
    });
    expect(readFailureBrand(new DerivedFailureError("x"))).toEqual({
      reason: "rls_denied",
      source: "class",
    });
  });

  test("a computed declaration reads the instance", () => {
    expect(readFailureBrand(new ComputedFailureError(true))?.reason).toBe(
      "upstream_unavailable",
    );
    expect(readFailureBrand(new ComputedFailureError(false))?.reason).toBe(
      "unclassified",
    );
  });

  test("an instance classification wins over its class", () => {
    const error = classifyFailure(new DeclaredFailureError("x"), "not_found");
    expect(readFailureBrand(error)).toEqual({
      reason: "not_found",
      source: "instance",
    });
  });

  test("a same-named foreign class is not the declared one", () => {
    const Foreign = Object.defineProperty(class extends Error {}, "name", {
      value: DeclaredFailureError.name,
    });
    expect(Foreign.name).toBe(DeclaredFailureError.name);
    expect(readFailureBrand(new Foreign("x"))).toBeUndefined();
  });

  test("string properties cannot spoof a classification", () => {
    const spoofed = Object.assign(new Error("x"), {
      failureReason: "generation_cancelled",
      reason: "generation_cancelled",
      _tag: "AIGenerationCancelledError",
    });
    expect(readFailureBrand(spoofed)).toBeUndefined();
    expect(
      readFailureBrand(JSON.parse('{"reason":"generation_cancelled"}')),
    ).toBeUndefined();
  });

  test("an invalid declaration is recorded, not ignored", () => {
    class MisdeclaredError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "MisdeclaredError";
      }
    }
    class ThrowingError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ThrowingError";
      }
    }
    // The runtime check exists for untyped callers, so the test reaches it
    // through `Reflect.apply` rather than a cast.
    Reflect.apply(declareFailureClass, undefined, [
      MisdeclaredError,
      "not-a-reason",
    ]);
    declareFailureClass(ThrowingError, () => {
      throw new TypeError("declaration failed");
    });
    expect(readFailureBrand(new MisdeclaredError("x"))?.reason).toBe(
      "invalid_declaration",
    );
    expect(readFailureBrand(new ThrowingError("x"))?.reason).toBe(
      "invalid_declaration",
    );
    expect(
      readFailureBrand(
        Reflect.apply(classifyFailure, undefined, [new Error("x"), "nope"]),
      )?.reason,
    ).toBe("invalid_declaration");
  });

  test("hostile values read as unbranded without throwing", () => {
    const { proxy, revoke } = Proxy.revocable(new Error("x"), {});
    revoke();
    const lyingPrototype = new Proxy(new Error("x"), {
      getPrototypeOf: () => {
        throw new TypeError("no prototype for you");
      },
    });
    const endless: object = new Proxy(
      {},
      {
        getPrototypeOf: () => endless,
      },
    );
    expect(readFailureBrand(proxy)).toBeUndefined();
    expect(readFailureBrand(lyingPrototype)).toBeUndefined();
    expect(readFailureBrand(endless)).toBeUndefined();
    expect(readFailureBrand("thrown string")).toBeUndefined();
    expect(readFailureBrand(null)).toBeUndefined();
  });
});
