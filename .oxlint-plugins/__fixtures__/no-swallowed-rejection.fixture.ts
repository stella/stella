// Passive regression fixture for the rejection guards exported by
// `no-swallowed-rejection`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// each rule MUST flag. If a rule regresses, the matching disable becomes unused
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
declare const success: (value: string) => void;

// MUST flag: `null` fallback.
const nullFallback = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection, no-swallowed-rejection/require-rejection-parameter
  const value = await risky().catch(() => null);
  return value;
};

// MUST flag: `undefined` fallback.
const undefinedFallback = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection, no-swallowed-rejection/require-rejection-parameter
  const value = await risky().catch(() => undefined);
  return value;
};

// MUST flag: empty block.
const emptyBlock = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection, no-swallowed-rejection/require-rejection-parameter, no-empty-function
  await risky().catch(() => {});
};

// MUST flag: block whose only content is a comment.
const commentOnlyBlock = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection, no-swallowed-rejection/require-rejection-parameter
  await risky().catch(() => {
    /* fire-and-forget */
  });
};

// MUST flag: string, number and empty-collection fallbacks.
const stringFallback = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection, no-swallowed-rejection/require-rejection-parameter
  const value = await risky().catch(() => "");
  return value;
};
const numberFallback = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection, no-swallowed-rejection/require-rejection-parameter
  const value = await risky().catch(() => 1);
  return value;
};
const emptyArrayFallback = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection, no-swallowed-rejection/require-rejection-parameter
  const value = await risky().catch(() => []);
  return value;
};
const emptyObjectFallback = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection, no-swallowed-rejection/require-rejection-parameter
  const value = await risky().catch(() => ({}));
  return value;
};

// MUST flag: an explicit `return` of a constant is the same swallow.
const returnedConstant = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection, no-swallowed-rejection/require-rejection-parameter, arrow-body-style
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
    // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection, no-swallowed-rejection/require-rejection-parameter
    .catch(() => null);
  return contents;
};

// MUST flag: extracting the file handle into a local is the same read, so it
// must not buy the allowlisted-method verdict the inline form is denied.
const configuredFileReadViaAlias = async () => {
  const file = Bun.file("/etc/token");
  // oxlint-disable-next-line no-swallowed-rejection/no-swallowed-rejection, no-swallowed-rejection/require-rejection-parameter
  const contents = await file.text().catch(() => null);
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

// --- Cases for require-rejection-parameter ---

// MUST flag: an inline catch callback can run on a rejection without binding
// the reason, even when another side effect makes it unlike a constant swallow.
const inlineCatchWithoutReason = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/require-rejection-parameter
  await risky().catch(() => {
    captureError("inline callback did not receive the rejection");
  });
};

// MUST flag: the second argument to `.then` is the rejection callback.
const thenWithoutReason = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/require-rejection-parameter
  await risky().then(success, () => {
    captureError("then callback did not receive the rejection");
  });
};

// MUST flag: a named callback and a const alias are resolved through their
// lexical bindings, rather than judged by the spelling at the call site.
const namedWithoutReason = () => {
  captureError("named callback did not receive the rejection");
};
const aliasWithoutReason = namedWithoutReason;
const namedRejectionCallbacks = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/require-rejection-parameter
  await risky().catch(aliasWithoutReason);
  // oxlint-disable-next-line no-swallowed-rejection/require-rejection-parameter
  await risky().then(success, namedWithoutReason);
};

// A function declaration is a locally resolvable callback with the same
// parameter contract as an inline function.
function declaredWithoutReason() {
  captureError("declared callback did not receive the rejection");
}
const declaredRejectionCallback = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/require-rejection-parameter
  await risky().catch(declaredWithoutReason);
};

// Static computed names and optional member calls are Promise-style calls. A
// dynamic property remains intentionally opaque to avoid matching unrelated
// APIs that happen to store a method named `catch` or `then`.
const staticComputedAndOptionalCalls = async () => {
  // oxlint-disable-next-line no-swallowed-rejection/require-rejection-parameter, typescript/dot-notation -- static computed Promise method exercises the rule's resolver
  await risky()["catch"](() => {
    captureError("computed callback did not receive the rejection");
  });
  // oxlint-disable-next-line no-swallowed-rejection/require-rejection-parameter, typescript/no-unnecessary-condition -- optional Promise method exercises the rule's resolver
  await risky()?.catch(() => {
    captureError("optional callback did not receive the rejection");
  });
  const method = "catch";
  await risky()[method](() => {
    captureError("dynamic method is intentionally opaque");
  });
};

// Static computed allowlisted receivers keep the same body-consumption and
// teardown exemptions as their dot-notation forms.
const computedAllowedReceivers = async () => {
  // oxlint-disable-next-line typescript/dot-notation -- static computed allowlist method exercises receiver resolution
  const detail = await response["text"]().catch(() => "");
  // oxlint-disable-next-line typescript/dot-notation -- static computed allowlist method exercises receiver resolution
  await reader["cancel"]().catch(() => undefined);
  return detail;
};

// Binding and using the reason remains valid for both callback positions.
const namedWithReason = (error: unknown) => {
  captureError(error);
};
const handledNamedRejectionCallbacks = async () => {
  await risky().catch(namedWithReason);
  await risky().then(success, namedWithReason);
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
  configuredFileReadViaAlias,
  readerTeardown,
  bodyDrain,
  capturedFallback,
  handledRejection,
  inlineCatchWithoutReason,
  thenWithoutReason,
  namedRejectionCallbacks,
  declaredRejectionCallback,
  staticComputedAndOptionalCalls,
  computedAllowedReceivers,
  handledNamedRejectionCallbacks,
};
