type CommandOutcome<T> =
  | { result: T; status: "completed" }
  | { status: "busy" };

/**
 * The worker's single owner of browser control. Web commands and every
 * change to the pairing, the controlled tab or website access run one at a
 * time, in arrival order. A cancel or a change starts a new epoch: the
 * running command's signal aborts at once, and a command admitted in an older
 * epoch starts with its signal already aborted, so it never reaches the page.
 */
export const createControlSession = () => {
  let epoch = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let running: AbortController | null = null;
  let commandAdmitted = false;

  const serialize = async <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return await next;
  };

  const interrupt = (): void => {
    epoch += 1;
    running?.abort();
  };

  return {
    /** Aborts the running command and every command admitted before now. */
    cancel(): void {
      interrupt();
    },
    /**
     * Interrupts running and admitted commands, then applies `change` once
     * the running command has unwound.
     */
    async change<T>(change: () => Promise<T>): Promise<T> {
      interrupt();
      return await serialize(change);
    },
    /**
     * Admits one web command at a time; another that arrives while one is
     * waiting or running is refused as busy. Call synchronously on receipt,
     * so a cancel sent after the command always reaches it.
     */
    async runCommand<T>(
      execute: (signal: AbortSignal) => Promise<T>,
    ): Promise<CommandOutcome<T>> {
      if (commandAdmitted) {
        return { status: "busy" };
      }
      commandAdmitted = true;
      const admittedEpoch = epoch;
      try {
        const result = await serialize(async () => {
          const controller = new AbortController();
          if (admittedEpoch !== epoch) {
            controller.abort();
          }
          running = controller;
          try {
            return await execute(controller.signal);
          } finally {
            running = null;
          }
        });
        return { result, status: "completed" };
      } finally {
        commandAdmitted = false;
      }
    },
  };
};
