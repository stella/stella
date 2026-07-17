/**
 * Read an untrusted byte stream up to a hard cap. The reader is cancelled on
 * overflow or failure and its lock is released on every exit path.
 */
export const readCappedBytes = async (
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | null> => {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflowed = false;
  const readable = {
    [Symbol.asyncIterator]: () => ({
      next: async () => await reader.read(),
    }),
  };

  try {
    for await (const value of readable) {
      total += value.byteLength;
      if (total > maxBytes) {
        overflowed = true;
        break;
      }
      chunks.push(value);
    }
    if (overflowed) {
      await reader.cancel();
      return null;
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
};
