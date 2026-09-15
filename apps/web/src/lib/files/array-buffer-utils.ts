import { replaceEqualDeep } from "@tanstack/react-query";

type StableArrayBufferOptions = {
  incomingBuffer: ArrayBuffer;
  stableBuffer?: ArrayBuffer | undefined;
};

export const areArrayBuffersEqual = (
  first: ArrayBuffer,
  second: ArrayBuffer,
) => {
  if (first === second) {
    return true;
  }

  if (first.byteLength !== second.byteLength) {
    return false;
  }

  const firstBytes = new Uint8Array(first);
  const secondBytes = new Uint8Array(second);
  for (let index = 0; index < firstBytes.length; index += 1) {
    if (firstBytes[index] !== secondBytes[index]) {
      return false;
    }
  }

  return true;
};

export const selectStableArrayBuffer = ({
  incomingBuffer,
  stableBuffer,
}: StableArrayBufferOptions) => {
  if (
    stableBuffer === undefined ||
    !areArrayBuffersEqual(incomingBuffer, stableBuffer)
  ) {
    return incomingBuffer;
  }

  return stableBuffer;
};

/** Keep refetched file data stable when metadata and bytes are unchanged. */
export const shareFileData = (
  previous: unknown,
  incoming: unknown,
): unknown => {
  if (
    typeof previous !== "object" ||
    previous === null ||
    typeof incoming !== "object" ||
    incoming === null ||
    !("buffer" in previous) ||
    !("buffer" in incoming) ||
    !(previous.buffer instanceof ArrayBuffer) ||
    !(incoming.buffer instanceof ArrayBuffer)
  ) {
    return replaceEqualDeep(previous, incoming);
  }

  const next = {
    ...incoming,
    buffer: selectStableArrayBuffer({
      incomingBuffer: incoming.buffer,
      stableBuffer: previous.buffer,
    }),
  };
  return replaceEqualDeep(previous, next);
};
