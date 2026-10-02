/**
 * Live composers by thread. The main chat and an inspector chat are often
 * mounted together, so an insert must reach the composer of the thread it
 * names, not whichever composer registered last. A thread shown twice
 * targets the composer mounted last.
 */
export type MountedEditors<T> = Map<string, readonly T[]>;

/** Registers a composer; the returned function removes that one only. */
export const mountEditor = <T>(
  editors: MountedEditors<T>,
  threadKey: string,
  handle: T,
): (() => void) => {
  const mounted = editors.get(threadKey);
  editors.set(
    threadKey,
    mounted === undefined ? [handle] : [...mounted, handle],
  );
  return () => {
    const current = editors.get(threadKey);
    if (current === undefined) {
      return;
    }
    const remaining = current.filter((registered) => registered !== handle);
    if (remaining.length === 0) {
      editors.delete(threadKey);
    } else {
      editors.set(threadKey, remaining);
    }
  };
};

/** The composer to act on for a thread, or null when none is mounted. */
export const mountedEditorFor = <T>(
  editors: MountedEditors<T> | null,
  threadKey: string,
): T | null => editors?.get(threadKey)?.at(-1) ?? null;
