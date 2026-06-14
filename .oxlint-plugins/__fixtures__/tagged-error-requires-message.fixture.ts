// Passive regression fixture for
// `tagged-error-requires-message/tagged-error-requires-message`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses (e.g. someone drops the non-optional
// or `string`-type check and a bare `message` member again satisfies it), the
// matching disable becomes unused and
// `--report-unused-disable-directives-severity=error` fails CI.

import { TaggedError } from "better-result";

// Inline literal with no `message` at all.
// oxlint-disable-next-line tagged-error-requires-message/tagged-error-requires-message
class MissingMessageError extends TaggedError("MissingMessageError")<{
  id: string;
}>() {}

// `message` present but optional.
// oxlint-disable-next-line tagged-error-requires-message/tagged-error-requires-message
class OptionalMessageError extends TaggedError("OptionalMessageError")<{
  message?: string;
}>() {}

// `message` present but not typed `string`.
// oxlint-disable-next-line tagged-error-requires-message/tagged-error-requires-message
class NonStringMessageError extends TaggedError("NonStringMessageError")<{
  message: unknown;
}>() {}

// --- Cases the rule MUST NOT flag ---

// Non-optional `message: string`.
class ValidError extends TaggedError("ValidError")<{
  message: string;
}>() {}

// Named-alias props are resolved elsewhere and intentionally skipped.
type AliasProps = { message: string };
class AliasError extends TaggedError("AliasError")<AliasProps>() {}

export const __taggedErrorMessageFixture = {
  MissingMessageError,
  OptionalMessageError,
  NonStringMessageError,
  ValidError,
  AliasError,
};
