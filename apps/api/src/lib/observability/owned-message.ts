/**
 * Which error messages a failure record may carry as text.
 *
 * Failure records live for a year, and an error's message is free text: a
 * validation error quotes the value it rejected, a provider echoes the request,
 * a tool error carries model-written input. So a record carries a message only
 * when the code that owns the error wrote it as a fixed string. `ownedMessage`
 * accepts only a string literal, so a message built at runtime cannot type as
 * owned; an error class declares its message `OwnedMessage` and carries
 * `OWNED_MESSAGE`. Every other error is described by its tag, SQLSTATE and
 * cause chain of tags alone.
 */

/** The longest owned message a failure record carries. */
export const OWNED_MESSAGE_MAX_LENGTH = 200;

declare const OWNED: unique symbol;

export type OwnedMessage = string & { readonly [OWNED]: true };

/** Marks an error class whose `message` is an `OwnedMessage`. */
export const OWNED_MESSAGE: unique symbol = Symbol("stella.ownedMessage");

// A union of literals passes; `string` and templates with a `${string}` hole
// (`Record<never, never> extends Record<T, 1>` holds only for an index signature) do not.
type LiteralMessage<T extends string> = string extends T
  ? never
  : Record<never, never> extends Record<T, 1>
    ? never
    : T;

// `LiteralMessage` admits only a compile-time string literal, which the code
// that wrote it owns; narrowing records that in the brand.
const brandOwned: (message: string) => asserts message is OwnedMessage = () => {
  // The check is the caller's literal; nothing remains to verify at runtime.
};

export const ownedMessage = <const T extends string>(
  message: LiteralMessage<T>,
): OwnedMessage => {
  const text: string = message;
  brandOwned(text);
  return text;
};

/** The capped message of an error that owns it; undefined for any other. */
export const ownedMessageOf = (error: unknown): string | undefined => {
  if (!(error instanceof Error) || Reflect.get(error, OWNED_MESSAGE) !== true) {
    return undefined;
  }
  return error.message.slice(0, OWNED_MESSAGE_MAX_LENGTH);
};
