import { panic } from "better-result";

/**
 * A push queue read as an async iterable by one consumer. Adapters push
 * harness events as their native protocol delivers them; the consumer reads
 * at its own pace and the iteration ends once the queue is closed and empty.
 */
export type EventQueue<T> = {
  push: (item: T) => void;
  close: () => void;
  readonly items: AsyncIterable<T>;
};

export const createEventQueue = <T>(): EventQueue<T> => {
  const buffered: T[] = [];
  const state: {
    closed: boolean;
    consumed: boolean;
    wake: (() => void) | null;
  } = { closed: false, consumed: false, wake: null };

  const notify = () => {
    const wake = state.wake;
    state.wake = null;
    wake?.();
  };

  async function* read(): AsyncGenerator<T> {
    for (;;) {
      const next = buffered.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (state.closed) {
        return;
      }
      const { promise, resolve } = Promise.withResolvers<undefined>();
      state.wake = () => resolve(undefined);
      await promise;
    }
  }

  return {
    push: (item) => {
      if (state.closed) {
        return;
      }
      buffered.push(item);
      notify();
    },
    close: () => {
      state.closed = true;
      notify();
    },
    items: {
      [Symbol.asyncIterator]: () => {
        if (state.consumed) {
          return panic("A harness event stream has a single consumer.");
        }
        state.consumed = true;
        return read();
      },
    },
  };
};
