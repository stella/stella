// Passive regression fixture for `no-object-url-leak/no-object-url-leak`.
//
// Rule-specific disables mark creations the rule MUST reject. If detection
// regresses, unused-directive reporting fails this fixture. Unannotated calls
// cover the supported local disposal and shadowing patterns.

declare const blob: Blob;
declare const blobs: readonly Blob[];
declare const condition: boolean;
declare const existingObjectUrl: string;
declare const mode: "keep" | "skip";

// MUST flag: an escaped Blob URL has no visible owner or cleanup.
export const escapedUrl = () =>
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: returned Blob URL has no local revocation
  URL.createObjectURL(blob);

// MUST flag: binding the result without revoking it still pins the Blob.
export const retainedUrl = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: local Blob URL is never revoked
  const url = URL.createObjectURL(blob);
  return url;
};

// MUST flag: explicit globalThis access is the same browser API.
export const explicitGlobalUrl = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: explicit global namespace cannot bypass disposal
  globalThis.URL.createObjectURL(blob);
};

// MUST flag: revoking an earlier value does not dispose a later assignment.
export const revokeBeforeCreate = () => {
  let url = "blob:old";
  URL.revokeObjectURL(url);
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: revocation precedes this creation
  url = URL.createObjectURL(blob);
  return url;
};

// MUST flag: an immutable alias captured before the ownership write still
// points at the old value and cannot revoke the newly created URL.
export const staleAliasCleanup = () => {
  let url = "blob:old";
  const staleUrl = url;
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak, eslint/no-useless-assignment -- fixture: pre-creation alias cannot dispose the new assigned value
  url = URL.createObjectURL(blob);
  URL.revokeObjectURL(staleUrl);
};

// MUST flag: an early return can bypass the lexically later revocation.
export const conditionalEarlyReturn = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: cleanup does not cover the early-return path
  const url = URL.createObjectURL(blob);
  if (condition) {
    return;
  }
  URL.revokeObjectURL(url);
};

// MUST flag: conditional cleanup does not cover the false branch.
export const conditionalRevocation = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: cleanup is not guaranteed on every branch
  const url = URL.createObjectURL(blob);
  if (condition) {
    URL.revokeObjectURL(url);
  }
};

// MUST flag: an early return can bypass registration of the cleanup callback.
export const conditionalCleanupCallback = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: the returned cleanup does not cover the early-return path
  const url = URL.createObjectURL(blob);
  if (condition) {
    return () => undefined;
  }
  return () => URL.revokeObjectURL(url);
};

// MUST flag: an early return can bypass timer registration.
export const conditionalTimerRegistration = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: timer cleanup does not cover the early-return path
  const url = URL.createObjectURL(blob);
  const cleanup = () => URL.revokeObjectURL(url);
  if (condition) {
    return;
  }
  setTimeout(cleanup, 1000);
};

// MUST flag: registering a callback does not help when that callback can skip
// revocation internally.
export const conditionalTimerCleanup = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: callback cleanup is conditional
  const url = URL.createObjectURL(blob);
  const cleanup = () => {
    if (condition) {
      URL.revokeObjectURL(url);
    }
  };
  setTimeout(cleanup, 1000);
};

// MUST flag: a `finally` block must revoke on every path through the block.
export const conditionalFinallyCleanup = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: finally cleanup is conditional
  const url = URL.createObjectURL(blob);
  try {
    return;
  } finally {
    if (condition) {
      URL.revokeObjectURL(url);
    }
  }
};

// MUST flag: the left side of && is a distinct, truthy object URL. The right
// side becomes the assigned result, so revoking that result cannot free the
// first Blob.
export const accumulatingLogicalAnd = () => {
  const url =
    // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: logical AND creates two live ownership values
    URL.createObjectURL(blob) &&
    // The assigned right-side creation is revoked and must remain clean.
    URL.createObjectURL(blob);
  URL.revokeObjectURL(url);
};

// MUST flag: the URL created on the left of && is discarded when the logical
// expression selects a replacement string. Revoking that result cannot free
// the created Blob URL.
export const replacedLogicalAnd = () => {
  const url =
    // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: logical AND discards the created URL for a replacement value
    URL.createObjectURL(blob) && "replacement";
  URL.revokeObjectURL(url);
};

// MUST flag: a loop can overwrite the same ownership binding on every
// iteration; one revocation after the loop only disposes the final URL.
export const repeatedLoopWithPostCleanup = () => {
  let url = "blob:initial";
  for (const currentBlob of blobs)
    // oxlint-disable-next-line no-object-url-leak/no-object-url-leak, eslint/curly -- fixture: unbraced loop exposes the post-loop cleanup false proof
    url = URL.createObjectURL(currentBlob);
  URL.revokeObjectURL(url);
};

// MUST flag: a continue targeting the creation loop bypasses that iteration's
// lexically later cleanup.
export const outerContinueBypassesCleanup = () => {
  for (const currentBlob of blobs) {
    // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: outer-loop continue skips per-iteration cleanup
    const url = URL.createObjectURL(currentBlob);
    if (condition) {
      continue;
    }
    URL.revokeObjectURL(url);
  }
};

// MUST flag: labeled control targeting the creation loop also bypasses the
// current iteration's cleanup.
export const labeledBreakBypassesCleanup = () => {
  // oxlint-disable-next-line eslint/no-labels -- fixture: labeled outer-loop exit is the control-flow shape under test
  creationLoop: for (const currentBlob of blobs) {
    // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: labeled break exits before cleanup
    const url = URL.createObjectURL(currentBlob);
    for (const candidate of blobs) {
      if (condition && candidate === currentBlob) {
        // oxlint-disable-next-line eslint/no-labels -- fixture: labeled break targets the creation loop
        break creationLoop;
      }
    }
    URL.revokeObjectURL(url);
  }
};

export const labeledContinueBypassesCleanup = () => {
  // oxlint-disable-next-line eslint/no-labels -- fixture: labeled outer-loop continue is the control-flow shape under test
  creationLoop: for (const currentBlob of blobs) {
    // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: labeled continue skips cleanup
    const url = URL.createObjectURL(currentBlob);
    for (const candidate of blobs) {
      if (condition && candidate === currentBlob) {
        // oxlint-disable-next-line eslint/no-labels -- fixture: labeled continue targets the creation loop
        continue creationLoop;
      }
    }
    URL.revokeObjectURL(url);
  }
};

// Allowed: direct local pairing with the same binding.
export const downloadUrl = () => {
  const url = URL.createObjectURL(blob);
  URL.revokeObjectURL(url);
};

// Allowed: immutable aliases preserve the same produced value.
export const aliasedCleanup = () => {
  const url = window.URL.createObjectURL(blob);
  const cleanupUrl = url;
  window.URL.revokeObjectURL(cleanupUrl);
};

// Allowed: a returned cleanup callback closes over the created URL.
export const cleanupCallback = () => {
  const url = URL.createObjectURL(blob);
  return () => URL.revokeObjectURL(url);
};

// Allowed: an unconditionally registered timer provides bounded cleanup for a
// resource that must outlive the current synchronous operation.
export const scheduledCleanup = () => {
  const url = URL.createObjectURL(blob);
  const cleanup = () => URL.revokeObjectURL(url);
  setTimeout(cleanup, 1000);
};

// Allowed: nested-loop break/continue inside a returned cleanup callback do
// not bypass the callback's later revocation.
export const returnedCleanupWithNestedLoop = () => {
  const url = URL.createObjectURL(blob);
  return () => {
    for (const candidate of blobs) {
      if (candidate === blob) {
        continue;
      }
      break;
    }
    URL.revokeObjectURL(url);
  };
};

// Allowed: the same target-aware proof applies inside a registered timer
// cleanup callback.
export const timerCleanupWithNestedLoop = () => {
  const url = URL.createObjectURL(blob);
  const cleanup = () => {
    for (const candidate of blobs) {
      if (candidate === blob) {
        continue;
      }
      break;
    }
    URL.revokeObjectURL(url);
  };
  setTimeout(cleanup, 1000);
};

// Allowed: conditional creation has one ownership write and revokes whichever
// branch produced the value.
export const conditionalCleanup = () => {
  const url = condition
    ? URL.createObjectURL(blob)
    : globalThis.URL.createObjectURL(blob);
  URL.revokeObjectURL(url);
};

// Allowed: object URLs are truthy and non-nullish strings, so the right sides
// of || and ?? are mutually exclusive fallbacks rather than accumulating
// ownership writes.
export const logicalFallbackCleanup = () => {
  const runtimeFallbackUrl =
    existingObjectUrl || globalThis.URL.createObjectURL(blob);
  URL.revokeObjectURL(runtimeFallbackUrl);
  const orUrl =
    URL.createObjectURL(blob) || globalThis.URL.createObjectURL(blob);
  URL.revokeObjectURL(orUrl);
  const nullishUrl =
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- fixture: exercise conservative ?? ownership handling
    URL.createObjectURL(blob) ?? globalThis.URL.createObjectURL(blob);
  URL.revokeObjectURL(nullishUrl);
};

// Allowed: `finally` revokes the URL even when the work exits abruptly.
export const finallyCleanup = () => {
  const url = URL.createObjectURL(blob);
  try {
    if (condition) {
      return;
    }
  } finally {
    URL.revokeObjectURL(url);
  }
};

// Allowed: a finally nested inside the creation loop runs once for every
// ownership write, including continue/return paths through that iteration.
export const perIterationFinallyCleanup = () => {
  for (const currentBlob of blobs) {
    const url = URL.createObjectURL(currentBlob);
    try {
      if (condition) {
        continue;
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }
};

// Allowed: a ForStatement initializer executes once, so one unconditional
// cleanup after the loop covers that ownership write.
export const forInitializerCleanup = () => {
  let url: string;
  let iteration = 0;
  for (url = URL.createObjectURL(blob); iteration < 1; iteration += 1) {
    void url;
  }
  URL.revokeObjectURL(url);
};

// Allowed: break/continue inside a nested loop and break inside a nested
// switch target those nested constructs; all paths still reach the outer
// iteration's later cleanup.
export const nestedAbruptCompletionsStillCleanUp = () => {
  for (const currentBlob of blobs) {
    const url = URL.createObjectURL(currentBlob);
    for (const candidate of blobs) {
      if (candidate === currentBlob) {
        continue;
      }
      break;
    }
    for (const candidate of blobs) {
      if (candidate === currentBlob) {
        break;
      }
    }
    switch (mode) {
      case "skip":
        break;
      case "keep":
        void currentBlob;
        break;
    }
    URL.revokeObjectURL(url);
  }
};

// Allowed: immediate create/revoke is unusual but does not retain the Blob.
export const immediateCleanup = () =>
  URL.revokeObjectURL(URL.createObjectURL(blob));

// Allowed: locally injected URL-shaped objects are not the browser global.
export const useInjectedUrl = (URL: {
  createObjectURL: (value: Blob) => string;
}) => URL.createObjectURL(blob);

// Allowed: a locally injected window is not the browser global host.
export const useInjectedWindow = (window: {
  URL: { createObjectURL: (value: Blob) => string };
}) => window.URL.createObjectURL(blob);
