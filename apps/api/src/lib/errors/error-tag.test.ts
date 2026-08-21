import { panic, Panic, TaggedError, UnhandledException } from "better-result";
import { describe, expect, test } from "bun:test";

import { errorClassName, errorTag } from "@/api/lib/errors/error-tag";

class ExampleTaggedError extends TaggedError("ExampleTaggedError")<{
  message: string;
}> {}

// These two fixtures exist to break the convention `custom-error-definition`
// enforces — a class whose identifier and declared name disagree, and a class
// that declares no name at all. `errorClassName` has to name both, so the
// fixtures cannot be made rule-compliant without erasing what they test.
/* eslint-disable unicorn/custom-error-definition */

// The shape a bundler emits when a class expression collides with the outer
// binding it is assigned to: a distinct, suffixed identifier over a `name`
// that keeps the source spelling.
const BundlerRenamedError = class BundlerRenamedError2 extends Error {
  constructor() {
    super("query failed");
    this.name = "BundlerRenamedError";
  }
};

class SilentError extends Error {}

/* eslint-enable unicorn/custom-error-definition */

describe("errorClassName", () => {
  // `better-result` ships minified, so `Panic` is bound to a single letter
  // and `UnhandledException` is an anonymous class expression named after
  // the binding it was assigned to. Both write the real name onto the
  // instance, which is the only spelling that identifies the class.
  test("names a minified dependency's error classes", () => {
    expect(errorClassName(new Panic({ message: "invariant broken" }))).toBe(
      "Panic",
    );
    expect(
      errorClassName(new UnhandledException({ cause: new Error("boom") })),
    ).toBe("UnhandledException");
  });

  test("names a bundler-suffixed class by its declared name", () => {
    const error = new BundlerRenamedError();

    // Guard the fixture: without a divergence there is nothing to prefer.
    expect(error.constructor.name).toBe("BundlerRenamedError2");
    expect(errorClassName(error)).toBe("BundlerRenamedError");
  });

  test("falls back to the constructor for a class that declares no name", () => {
    const error = new SilentError("boom");

    // Guard the fixture: `name` is inherited here, not declared.
    expect(error.name).toBe("Error");
    expect(errorClassName(error)).toBe("SilentError");
  });

  test("names built-in and tagged errors", () => {
    expect(errorClassName(new TypeError("bad access"))).toBe("TypeError");
    expect(errorClassName(new Error("plain"))).toBe("Error");
    expect(errorClassName(new ExampleTaggedError({ message: "nope" }))).toBe(
      "ExampleTaggedError",
    );
  });

  test("never throws on hostile accessors", () => {
    const error = new Error("boom");
    Object.defineProperties(error, {
      constructor: { get: () => panic("constructor getter failed") },
      name: { get: () => panic("name getter failed") },
    });

    expect(errorClassName(error)).toBe("Error");
  });
});

describe("errorTag", () => {
  test("prefers the tag, then the class name", () => {
    expect(errorTag(new ExampleTaggedError({ message: "nope" }))).toBe(
      "ExampleTaggedError",
    );
    expect(errorTag(new TypeError("bad access"))).toBe("TypeError");
    expect(errorTag("boom")).toBe("UnknownError");
  });
});
