// `--scopes` parsing. The flag selects resource scopes only: the identity set
// (`CLI_IDENTITY_SCOPES`) is added by `login()` on every run, so no `--scopes`
// value can drop `offline_access` and leave the session without a refresh
// token. Which resource scopes exist is ultimately the server's call
// (`opts.scopes` in `oauthProvider`, see the design brief's "let a
// feature-disabled call fail with the server's actual error" principle), so
// beyond the `stella:` prefix this only rejects obviously-malformed input
// (empty, containing whitespace) before it reaches a URL query string.

import { Result, TaggedError, type TaggedErrorClass } from "better-result";
import * as v from "valibot";

import { CLI_IDENTITY_SCOPES } from "./constants.js";

/** Marks the scopes `--scopes` may name; also drives the missing-scope hint. */
export const RESOURCE_SCOPE_PREFIX = "stella:";

const InvalidScopeInputErrorBase: TaggedErrorClass<"InvalidScopeInputError"> =
  TaggedError("InvalidScopeInputError");

class InvalidScopeInputError extends InvalidScopeInputErrorBase<{
  message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}

const scopeTokenSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.regex(/^\S+$/u, "Scope names cannot contain whitespace"),
);

export const parseScopesFlag = (
  input: string,
): Result<readonly string[], InvalidScopeInputError> => {
  const tokens = input
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return Result.err(new InvalidScopeInputError("--scopes was empty"));
  }

  const parsed = v.safeParse(v.array(scopeTokenSchema), tokens);
  if (!parsed.success) {
    return Result.err(
      new InvalidScopeInputError(
        `Invalid --scopes value: ${parsed.issues.map((issue) => issue.message).join("; ")}`,
      ),
    );
  }

  const rejected = parsed.output.filter(
    (scope) => !scope.startsWith(RESOURCE_SCOPE_PREFIX),
  );
  if (rejected.length > 0) {
    return Result.err(
      new InvalidScopeInputError(
        `--scopes accepts only ${RESOURCE_SCOPE_PREFIX} resource scopes, but got: ${rejected.join(", ")}. The identity scopes (${CLI_IDENTITY_SCOPES.join(", ")}) are always requested and cannot be selected here.`,
      ),
    );
  }

  return Result.ok(parsed.output);
};

export { InvalidScopeInputError };
