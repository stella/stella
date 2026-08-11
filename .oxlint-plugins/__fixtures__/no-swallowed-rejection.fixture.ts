// Passive regression fixture for `no-swallowed-rejection/no-swallowed-rejection`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The
// allowed cases carry no disable, so a false positive would fail the fixture
// too.

declare const risky: () => Promise<string>;
declare const reader: { cancel: (reason?: unknown) => Promise<void> };
declare const response: {
  body: { cancel: () => Promise<void> } | null;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};
declare const captureError: (error: unknown) => void;

// MUST flag: `null` fallback.
const nullFallback = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection
  const value = await risky().catch(() => null);
  return value;
};

// MUST flag: `undefined` fallback.
const undefinedFallback = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection
  const value = await risky().catch(() => undefined);
  return value;
};

// MUST flag: empty block.
const emptyBlock = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection, no-empty-function
  await risky().catch(() => {});
};

// MUST flag: block whose only content is a comment.
const commentOnlyBlock = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection
  await risky().catch(() => {
    /* fire-and-forget */
  });
};

// MUST flag: string, number and empty-collection fallbacks.
const stringFallback = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection
  const value = await risky().catch(() => "");
  return value;
};
const numberFallback = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection
  const value = await risky().catch(() => 1);
  return value;
};
const emptyArrayFallback = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection
  const value = await risky().catch(() => []);
  return value;
};
const emptyObjectFallback = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection
  const value = await risky().catch(() => ({}));
  return value;
};

// MUST flag: an explicit `return` of a constant is the same swallow.
const returnedConstant = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection, arrow-body-style
  const value = await risky().catch(() => {
    return null;
  });
  return value;
};

// MUST flag: a bound parameter changes nothing if the body drops it.
const boundButDropped = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection
  const value = await risky().catch((_error: unknown) => null);
  return value;
};

// MUST flag: a filesystem read at a configured path is not an optional body
// read, even though `text` is an allowlisted method name.
const configuredFileRead = async () => {
  const contents = await Bun.file("/etc/token")
    .text()
    // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection
    .catch(() => null);
  return contents;
};

// --- Cases the rule MUST NOT flag ---

// Allowed receiver: stream-reader teardown during unwind.
const readerTeardown = async () => {
  await reader.cancel().catch(() => undefined);
  await response.body?.cancel().catch(() => undefined);
};

// Allowed receiver: response-body consumption with a fallback body.
const bodyDrain = async () => {
  const payload: unknown = await response.json().catch(() => null);
  const detail = await response.text().catch(() => "");
  return { detail, payload };
};

// The rejection is captured before the fallback is returned.
const capturedFallback = async () => {
  const value = await risky().catch((error: unknown) => {
    captureError(error);
    return null;
  });
  return value;
};

// A real handler body is untouched.
const handledRejection = async () => {
  await risky().catch((error: unknown) => {
    captureError(error);
  });
};

export const __noSwallowedRejectionFixture = {
  nullFallback,
  undefinedFallback,
  emptyBlock,
  commentOnlyBlock,
  stringFallback,
  numberFallback,
  emptyArrayFallback,
  emptyObjectFallback,
  returnedConstant,
  boundButDropped,
  configuredFileRead,
  readerTeardown,
  bodyDrain,
  capturedFallback,
  handledRejection,
};
