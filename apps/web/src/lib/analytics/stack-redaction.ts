import { telemetryErrorType } from "./error-diagnostics";

// The deepest error in a `cause` chain carries the stack of the original
// failure site; wrapper classes (boundary telemetry errors) only record
// where they were constructed. `cause` is writable, so third-party code can
// hand us a cycle; the visited set bounds the walk.
const deepestCause = (error: Error): Error => {
  let current = error;
  const seen = new Set<Error>([error]);
  while (current.cause instanceof Error && !seen.has(current.cause)) {
    current = current.cause;
    seen.add(current);
  }
  return current;
};

// Engines disagree on frame syntax: V8 indents frames with `at ` under a
// `<name>: <message>` header, while SpiderMonkey and JavaScriptCore write
// bare `<symbol>@<url>:<line>:<column>` lines and no header at all. Known JSC
// engine labels contain spaces; other callsite labels stay symbol-shaped so
// free-form text cannot ride along as a frame.
const V8_STACK_FRAME_SYNTAX = /^\s+at /u;
const CALLSITE_STACK_FRAME_SYNTAX =
  /^(?:[Aa]sync\*)?(?:[\p{ID_Continue}$.<>[\]#~/]{0,120}|(?:global|module|eval) code)@\S+:\d+:\d+$/u;
// JavaScriptCore reports built-ins as `<symbol>@[native code]`: no location
// to keep, but a genuine stack start.
const CALLSITE_NATIVE_FRAME_SYNTAX =
  /^(?:[Aa]sync\*)?[\p{ID_Continue}$.<>[\]#~/]{0,120}@\[native code\]$/u;
type StackFrameSyntax = "callsite" | "v8";

// Neither callsite engine writes a header, so a stack whose first line is not
// a frame was assembled by hand (a copied message, a rehydrated V8 stack).
// Callsite-shaped lines below such a line are indistinguishable from message
// content, so the whole stack is untrusted.
const startsWithCallsiteFrame = (lines: readonly string[]): boolean => {
  const first = lines.find((line) => line.length > 0);
  return (
    first !== undefined &&
    (CALLSITE_STACK_FRAME_SYNTAX.test(first) ||
      CALLSITE_NATIVE_FRAME_SYNTAX.test(first))
  );
};

const hasOnlyDecimalDigits = (
  value: string,
  start: number,
  end: number,
): boolean => {
  if (start >= end) {
    return false;
  }
  for (let index = start; index < end; index += 1) {
    const code = value.codePointAt(index);
    if (code === undefined || code < 48 || code > 57) {
      return false;
    }
  }
  return true;
};

type StackFrameLocation = {
  lineSeparator: number;
  urlStart: number;
};

const stackFrameLocation = (frame: string): StackFrameLocation | undefined => {
  const frameEnd = frame.endsWith(")") ? frame.length - 1 : frame.length;
  const columnSeparator = frame.lastIndexOf(":", frameEnd - 1);
  const lineSeparator = frame.lastIndexOf(":", columnSeparator - 1);
  if (
    lineSeparator === -1 ||
    !hasOnlyDecimalDigits(frame, lineSeparator + 1, columnSeparator) ||
    !hasOnlyDecimalDigits(frame, columnSeparator + 1, frameEnd)
  ) {
    return undefined;
  }

  const v8Prefix = frame.trimStart().startsWith("at ")
    ? frame.indexOf("at ") + 3
    : -1;
  let urlStart = frame.indexOf("@") + 1;
  if (v8Prefix !== -1) {
    const locationSeparator = frame.indexOf(" (", v8Prefix);
    urlStart =
      locationSeparator === -1 || locationSeparator > lineSeparator
        ? v8Prefix
        : locationSeparator + 2;
  }
  return { lineSeparator, urlStart };
};

const sanitizeStackFrame = (frame: string): string | undefined => {
  const location = stackFrameLocation(frame);
  if (location === undefined) {
    return undefined;
  }
  const { lineSeparator, urlStart } = location;
  const serializedUrl = frame.slice(urlStart, lineSeparator);
  if (!URL.canParse(serializedUrl)) {
    return undefined;
  }
  const url = new URL(serializedUrl);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return undefined;
  }

  let urlEnd = lineSeparator;
  for (const terminator of ["?", "#"] as const) {
    const index = frame.indexOf(terminator, urlStart);
    if (index !== -1 && index < urlEnd) {
      urlEnd = index;
    }
  }
  if (urlEnd === lineSeparator) {
    return frame;
  }
  return `${frame.slice(0, urlEnd)}${frame.slice(lineSeparator)}`;
};

const runtimeStackFrameSyntax = (): StackFrameSyntax | undefined => {
  const stack = new Error("stack syntax probe").stack;
  if (typeof stack !== "string") {
    return undefined;
  }
  const lines = stack.split("\n").filter((line) => line.length > 0);
  if (lines.some((line) => V8_STACK_FRAME_SYNTAX.test(line))) {
    return "v8";
  }
  return lines.some((line) => CALLSITE_STACK_FRAME_SYNTAX.test(line))
    ? "callsite"
    : undefined;
};

type RedactTelemetryStackOptions = {
  errorType: string;
  stack: string;
  syntax: StackFrameSyntax;
};

export const redactTelemetryStack = ({
  errorType,
  stack,
  syntax,
}: RedactTelemetryStackOptions): string | undefined => {
  const lines = stack.split("\n");
  if (syntax === "callsite" && !startsWithCallsiteFrame(lines)) {
    return undefined;
  }
  const frameSyntax =
    syntax === "callsite" ? CALLSITE_STACK_FRAME_SYNTAX : V8_STACK_FRAME_SYNTAX;
  const frames: string[] = [];
  for (const line of lines) {
    if (!frameSyntax.test(line)) {
      continue;
    }
    const sanitized = sanitizeStackFrame(line);
    if (sanitized !== undefined) {
      frames.push(sanitized);
    }
  }
  if (frames.length === 0) {
    return undefined;
  }
  return [`${errorType}:`, ...frames].join("\n");
};

const redactedStack = (error: Error): string | undefined => {
  const { stack } = deepestCause(error);
  const syntax = runtimeStackFrameSyntax();
  if (typeof stack !== "string" || syntax === undefined) {
    return undefined;
  }
  return redactTelemetryStack({
    errorType: telemetryErrorType(error),
    stack,
    syntax,
  });
};

const toRedactedTelemetryError = (error: unknown): Error => {
  // eslint-disable-next-line unicorn/error-message -- the original message is intentionally dropped so telemetry cannot leak PII from the underlying error; the error class is carried in `.name` instead.
  const redacted = new Error("");
  redacted.name = telemetryErrorType(error);
  const stack = error instanceof Error ? redactedStack(error) : undefined;
  if (stack === undefined) {
    // Firefox exposes a lazy stack accessor after deleting the own property.
    // Shadow it explicitly so an unknown engine cannot regenerate an
    // unsanitized stack at SDK read time.
    Object.defineProperty(redacted, "stack", {
      configurable: true,
      value: undefined,
      writable: true,
    });
  } else {
    redacted.stack = stack;
  }
  return redacted;
};

export const captureRedactedException = (
  error: unknown,
  captureException: (redacted: Error) => void,
): void => {
  captureException(toRedactedTelemetryError(error));
};
