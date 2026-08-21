/**
 * The structural error identifier, split out from `errors/utils`.
 *
 * `errors/utils` initializes the dev error logger at import time and reads
 * `envBase` to do it, so importing it validates the whole API environment.
 * Modules that only need to name an error — the runner's env-free sweep
 * modules among them — import this instead and stay independent of that.
 * `errors/utils` re-exports these, so existing callers are unaffected.
 */

import { isTaggedError } from "better-result";

const GENERIC_ERROR_NAME = "Error";

/**
 * The name an error class assigns to itself, when it assigns one.
 *
 * `Error.prototype.name` is `"Error"`, so a class that never writes `name`
 * reports that generic value. Treat it as "declares nothing" and let the
 * caller fall back to the constructor identifier, which for such a class is
 * the more specific of the two.
 */
const declaredErrorName = (error: Error): string | undefined => {
  try {
    const name: unknown = Reflect.get(error, "name");
    if (typeof name === "string" && name && name !== GENERIC_ERROR_NAME) {
      return name;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const constructorIdentifier = (error: Error): string => {
  try {
    const constructorValue: unknown = Reflect.get(error, "constructor");
    if (typeof constructorValue !== "function") {
      return GENERIC_ERROR_NAME;
    }
    const name: unknown = Reflect.get(constructorValue, "name");
    if (typeof name === "string" && name) {
      return name;
    }
  } catch {
    return GENERIC_ERROR_NAME;
  }
  return GENERIC_ERROR_NAME;
};

/**
 * Name an error class.
 *
 * Prefers the `name` the class declares over its constructor's identifier: an
 * identifier is a build artifact, `name` is a string literal the class writes
 * onto every instance. The two diverge silently in three ways, each of which
 * renames the class without touching `name`:
 *  - a minifier rewrites the binding, so a dependency ships
 *    `class e extends Error { … this.name = "Panic" }`;
 *  - an anonymous class expression is named after whatever it is assigned to,
 *    so `var x = class extends Error {}` reports `"x"`;
 *  - a bundler flattens modules into one scope and suffixes the loser of a
 *    name collision, turning `DrizzleQueryError` into `DrizzleQueryError2`.
 *
 * Every such name is local to one build of one bundle, so none of them
 * identifies the class across builds, and none of them can be grepped for.
 * The declared name survives all three.
 */
export const errorClassName = (error: Error): string =>
  declaredErrorName(error) ?? constructorIdentifier(error);

/**
 * Extract a safe, structural error identifier for observability.
 *
 * Returns the TaggedError `_tag`, the error's class name, or
 * "UnknownError". Never includes messages, causes, or stack
 * traces; those may contain privileged document content, file
 * names, or client data that must not reach analytics dashboards.
 */
export const errorTag = (error: unknown): string => {
  if (isTaggedError(error)) {
    return error._tag;
  }
  if (error instanceof Error) {
    return errorClassName(error);
  }
  return "UnknownError";
};
