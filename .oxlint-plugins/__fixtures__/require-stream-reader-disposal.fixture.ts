// Passive regression fixture for
// `require-stream-reader-disposal/require-stream-reader-disposal`.
//
// Rule-specific disables mark acquisitions the rule MUST reject. If detection
// regresses, unused-directive reporting fails this fixture. Unannotated calls
// cover proven disposal, ownership transfer, and provenance boundaries.

declare const stopEarly: boolean;
declare const processChunk: (value: Uint8Array) => void;
declare const mightThrow: () => void;

// MUST flag: a locally owned reader keeps its stream locked when it is neither
// transferred nor released in a finally block.
export const leakedReader = async (stream: ReadableStream<Uint8Array>) => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: locally owned reader is never disposed
  const reader = stream.getReader();
  await reader.read();
};

// MUST flag: a release after the loop is bypassed by read rejection and is not
// an unconditional lifecycle boundary.
export const releaseOutsideFinally = async (
  stream: ReadableStream<Uint8Array>,
) => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: release is not protected by finally
  const reader = stream.getReader();
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
  }
  reader.releaseLock();
};

// MUST flag: an early return can stop the producer before EOF; releasing the
// lock does not cancel that producer.
export const earlyReturnWithoutCancel = async (
  stream: ReadableStream<Uint8Array>,
) => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: early return releases without cancelling
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      if (stopEarly) {
        return;
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
};

// MUST flag: a non-EOF break abandons the producer even though finally
// releases the reader lock.
export const breakWithoutCancel = async (
  stream: ReadableStream<Uint8Array>,
) => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: non-EOF break requires cancellation
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done || stopEarly) {
        break;
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
};

// Allowed: read rejection means the stream is already errored. The reader must
// still release its lock, but there is no active producer left to cancel.
export const naturalReadErrorRelease = async (
  stream: ReadableStream<Uint8Array>,
) => {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
};

// MUST flag: an explicit throw after a partial read leaves the producer active
// unless cancellation is guaranteed before finally releases the lock.
export const throwWithoutCancel = async (
  stream: ReadableStream<Uint8Array>,
) => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: explicit error exit releases without cancelling
  const reader = stream.getReader();
  try {
    await reader.read();
    throw new DOMException("stream failure", "OperationError");
  } finally {
    reader.releaseLock();
  }
};

// MUST flag: cancellation on only one branch does not cover the successful
// partial-read path through the other branch.
export const branchOnlyCancel = async (stream: ReadableStream<Uint8Array>) => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: conditional cancel does not dominate every partial-read path
  const reader = stream.getReader();
  try {
    await reader.read();
    if (stopEarly) {
      await reader.cancel().catch(() => undefined);
    }
  } finally {
    reader.releaseLock();
  }
};

// MUST flag: cleanup calls nested behind a short-circuit are not guaranteed to
// execute when the finalizer runs.
export const conditionalRelease = async (
  stream: ReadableStream<Uint8Array>,
) => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: conditional release does not discharge ownership
  const reader = stream.getReader();
  try {
    await reader.read();
  } finally {
    // oxlint-disable-next-line eslint/no-unused-expressions -- fixture: conditional cleanup is the unsafe shape under test
    stopEarly && reader.releaseLock();
  }
};

export const conditionalCancel = async (stream: ReadableStream<Uint8Array>) => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: conditional cancel cannot cover premature completion
  const reader = stream.getReader();
  try {
    await reader.read();
  } finally {
    // oxlint-disable-next-line eslint/no-unused-expressions -- fixture: conditional cleanup is the unsafe shape under test
    stopEarly && (await reader.cancel());
    reader.releaseLock();
  }
};

// MUST flag: consumer cancellation resumes an async generator at finally, so
// releaseLock without cancel leaves the producer active.
export async function* generatorWithoutCancel(
  stream: ReadableStream<Uint8Array>,
) {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: generator consumer can stop at yield without cancelling
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      yield result.value;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

// Allowed: EOF is the only ordinary loop exit, read failures cancel in catch,
// and finally releases the lock on both paths.
export const consumeToEnd = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
};

// Allowed: unconditional cancellation in finally covers early return and read
// rejection before releaseLock runs.
export const cancelEarlyExit = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  try {
    const result = await reader.read();
    if (!result.done && stopEarly) {
      return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

// Allowed: the cancel immediately after the one-shot read dominates every
// successful partial-read path; read rejection already errors the stream.
export const cancelAfterOneShotRead = async (
  stream: ReadableStream<Uint8Array>,
) => {
  const reader = stream.getReader();
  try {
    await reader.read();
    await reader.cancel().catch(() => undefined);
  } finally {
    reader.releaseLock();
  }
};

// Allowed: cancellation in the same branch dominates its early return, while
// EOF is a terminal stream state that needs only lock release.
export const cancelBeforeReturn = async (
  stream: ReadableStream<Uint8Array>,
) => {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      if (stopEarly) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
};

// Allowed: immutable aliases preserve the reader identity through disposal.
export const aliasedReaderCleanup = async (
  stream: ReadableStream<Uint8Array>,
) => {
  const reader = stream.getReader();
  const ownedReader = reader;
  try {
    await ownedReader.read();
  } finally {
    await ownedReader.cancel().catch(() => undefined);
    ownedReader.releaseLock();
  }
};

// Allowed: Response.body is a proven ReadableStream source rather than a
// method-name-only match.
export const responseBodyCleanup = async (response: Response) => {
  if (response.body === null) {
    return;
  }
  const reader = response.body.getReader();
  try {
    await reader.read();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

// Allowed: an awaited global fetch also proves Response.body provenance.
export const fetchedBodyCleanup = async (url: string) => {
  const response = await fetch(url);
  if (response.body === null) {
    return;
  }
  const reader = response.body.getReader();
  try {
    await reader.read();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

// Allowed: returning the reader explicitly transfers its lifecycle to the
// caller, both directly and through an immutable alias.
export const transferReader = (stream: ReadableStream<Uint8Array>) =>
  stream.getReader();

export const transferAliasedReader = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const transferredReader = reader;
  return transferredReader;
};

// MUST flag: transferring on only one branch leaves the other exit owning the
// reader without releasing its lock.
export const conditionalReaderTransfer = (
  stream: ReadableStream<Uint8Array>,
  transfer: boolean,
) => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: not every exit transfers ownership
  const reader = stream.getReader();
  if (transfer) {
    return reader;
  }
  return null;
};

// Allowed: consumer cancellation of an async generator reaches finally, where
// cancel runs before releaseLock.
export async function* cancellableGenerator(
  stream: ReadableStream<Uint8Array>,
) {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      yield result.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

// Allowed: method names do not establish Web Streams provenance.
export const unrelatedReader = async (source: {
  getReader: () => { read: () => Promise<string> };
}) => {
  const reader = source.getReader();
  return await reader.read();
};

// Allowed: a locally shadowed constructor is not the browser ReadableStream.
export const shadowedReadableStream = (
  ReadableStream: new () => { getReader: () => { read: () => string } },
) => {
  const reader = new ReadableStream().getReader();
  return reader.read();
};

// MUST flag: qualified browser globals have the same ReadableStream ownership
// semantics as the bare constructor.
export const leakedQualifiedGlobalReader = async () => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: qualified global stream reader is never released
  const reader = new globalThis.ReadableStream<Uint8Array>().getReader();
  return await reader.read();
};

// MUST flag: a rejecting cancel skips the following releaseLock call.
export const rejectingCancelSkipsRelease = async (
  stream: ReadableStream<Uint8Array>,
) => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: cancellation rejection can bypass lock release
  const reader = stream.getReader();
  try {
    await reader.read();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
};

// Allowed: a nested finalizer releases the lock even when cancellation rejects.
export const nestedReleaseFinalizer = async (
  stream: ReadableStream<Uint8Array>,
) => {
  const reader = stream.getReader();
  try {
    await reader.read();
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
};

// MUST flag: an intervening rejection can exit before ownership transfers.
export const throwingBeforeTransfer = async (
  stream: ReadableStream<Uint8Array>,
) => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: awaited work can reject before the final transfer
  const reader = stream.getReader();
  await Promise.resolve();
  return reader;
};

// MUST flag: an early exit before a later read/cancel pair is not covered by
// that trailing cancellation.
export const earlyExitBeforeTrailingCancel = async (
  stream: ReadableStream<Uint8Array>,
) => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: the first partial read can exit before trailing cancellation
  const reader = stream.getReader();
  try {
    await reader.read();
    if (stopEarly) {
      return;
    }
    await reader.read();
    await reader.cancel().catch(() => undefined);
  } finally {
    reader.releaseLock();
  }
};

// MUST flag: processing can reject after a partial read while only releasing
// the lock, leaving the producer active.
export const rejectingProcessingWithoutCancel = async (
  stream: ReadableStream<Uint8Array>,
) => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: processing rejection after a read requires cancellation
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      await Promise.resolve(result.value);
    }
  } finally {
    reader.releaseLock();
  }
};

// MUST flag: synchronous processing can throw after a partial read and also
// requires cancellation before the release-only finalizer.
export const throwingSynchronousProcessing = async (
  stream: ReadableStream<Uint8Array>,
) => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: synchronous processing throw after a read requires cancellation
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      processChunk(result.value);
    }
  } finally {
    reader.releaseLock();
  }
};

// MUST flag: qualified global fetch produces a genuine Response body whose
// reader ownership cannot be abandoned.
export const leakedQualifiedFetchReader = async (url: string) => {
  const response = await globalThis.fetch(url);
  if (!response.body) {
    return null;
  }
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: qualified global fetch reader is never released
  const reader = response.body.getReader();
  return await reader.read();
};

// Allowed: work in the proven EOF branch cannot abandon an active producer.
export const eofCallbackBeforeRelease = async (
  stream: ReadableStream<Uint8Array>,
) => {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        processChunk(new Uint8Array());
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
};

// MUST flag: destructuring preserves genuine Response.body provenance.
export const leakedDestructuredFetchBodyReader = async (url: string) => {
  const { body } = await fetch(url);
  if (!body) {
    return null;
  }
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: destructured fetch body reader is never released
  const reader = body.getReader();
  return await reader.read();
};

// MUST flag: an earlier sequence operand can throw before releaseLock runs.
export const throwingSequenceBeforeRelease = async (
  stream: ReadableStream<Uint8Array>,
) => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: throwing sequence operand can skip lock release
  const reader = stream.getReader();
  try {
    await reader.read();
  } finally {
    // oxlint-disable-next-line eslint/no-unused-expressions, typescript/no-confusing-void-expression -- fixture: sequence ordering is the unsafe cleanup shape under test
    (mightThrow(), reader.releaseLock());
  }
};

// MUST flag: Bun stdin exposes a genuine Web Stream reader.
export const leakedBunStdinReader = async () => {
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: Bun stdin reader is never released
  const reader = Bun.stdin.stream().getReader();
  return await reader.read();
};

// MUST flag: a mutable done binding cannot prove that a break means EOF.
export const reassignedDoneGuard = async () => {
  const stream = new ReadableStream<Uint8Array>();
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- fixture: reassigned done binding can break before EOF without cancellation
  const reader = stream.getReader();
  try {
    while (true) {
      let { done } = await reader.read();
      done = stopEarly;
      if (done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
};
