// `--scopes` parsing. Validity of individual scope names is ultimately the
// server's call (`opts.scopes` in `oauthProvider`, see the design brief's
// "let a feature-disabled call fail with the server's actual error"
// principle applied to scopes): this only rejects obviously-malformed input
// (empty, containing whitespace) before it reaches a URL query string.

import { Result } from "better-result";
import * as v from "valibot";

import { CliBaseError } from "./errors.js";

class InvalidScopeInputError extends CliBaseError<"InvalidScopeInputError"> {
  override readonly name = "InvalidScopeInputError";

  constructor(message: string) {
    super("InvalidScopeInputError", message);
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

  return Result.ok(parsed.output);
};

export { InvalidScopeInputError };
