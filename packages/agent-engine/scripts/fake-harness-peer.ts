import { appendFileSync, existsSync, readFileSync } from "node:fs";
import * as v from "valibot";

/**
 * What every fake harness CLI shares: the test log and the newline-delimited
 * JSON conversation over stdio. A fake reads its client's messages into named
 * queues and takes them one at a time as its scripted steps expect them.
 */

/** Appends each entry as one JSON line to `$FAKE_HARNESS_LOG`. */
export const fakeHarnessLog = (): ((entry: object) => void) => {
  const logPath = process.env["FAKE_HARNESS_LOG"] ?? "";
  return (entry) => {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  };
};

/**
 * The complete lines of a log another process may still be appending to.
 * A line counts once its newline is written; a trailing line without one is
 * still being written and is left for the next read. A log not yet created
 * has no lines.
 */
export const readCompleteLines = (logPath: string): string[] => {
  if (!existsSync(logPath)) {
    return [];
  }
  const text = readFileSync(logPath, "utf-8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((line) => line !== "");
};

/** Each complete JSON line of a log written by `fakeHarnessLog`, in order. */
export const readFakeHarnessLog = (logPath: string): unknown[] =>
  readCompleteLines(logPath).map((line): unknown => JSON.parse(line));

export const openFakeHarnessPeer = <
  TSchema extends v.GenericSchema,
  TQueue extends string,
>({
  schema,
  queueOf,
  log,
}: {
  /** Every line the client sends must parse with it. */
  schema: TSchema;
  /** The queue a received message waits in; null drops it. */
  queueOf: (message: v.InferOutput<TSchema>) => TQueue | null;
  log: (entry: object) => void;
}) => {
  type Message = v.InferOutput<TSchema>;
  const queues = new Map<TQueue, Message[]>();
  const queueNamed = (name: TQueue): Message[] => {
    const existing = queues.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const created: Message[] = [];
    queues.set(name, created);
    return created;
  };
  const state: { wake: (() => void) | null; closed: boolean } = {
    wake: null,
    closed: false,
  };
  const wakeReader = () => {
    const wake = state.wake;
    state.wake = null;
    if (wake !== null) {
      wake();
    }
  };

  /** Settles once the client has closed stdin. */
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const bytes of Bun.stdin.stream()) {
      buffer += decoder.decode(bytes, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const raw: unknown = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        log({ received: raw });
        const message = v.parse(schema, raw);
        const queue = queueOf(message);
        if (queue !== null) {
          queueNamed(queue).push(message);
        }
        wakeReader();
      }
    }
    state.closed = true;
    wakeReader();
  })();

  /** The next message in `name`, or null once stdin closes without one. */
  const take = async (name: TQueue): Promise<Message | null> => {
    const queue = queueNamed(name);
    for (;;) {
      const message = queue.shift();
      if (message !== undefined) {
        return message;
      }
      if (state.closed) {
        return null;
      }
      const { promise, resolve } = Promise.withResolvers<undefined>();
      state.wake = () => resolve(undefined);
      await promise;
    }
  };

  const write = (message: object) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  return { reading, take, write };
};
