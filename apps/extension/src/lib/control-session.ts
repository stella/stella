type CommandOutcome<T> =
  | { result: T; status: "completed" }
  | { status: "busy" };

type AdmittedCommand = {
  stop: AbortController;
  turnId: string;
};

/**
 * The worker's single owner of browser control. Web commands and every
 * change to the pairing, the controlled tab or website access run one at a
 * time, in arrival order. A change aborts the admitted command at once; a
 * stop from chat aborts it only when it belongs to the stopped turn. An
 * aborted command that has not started never reaches the page.
 */
export const createControlSession = () => {
  let tail: Promise<unknown> = Promise.resolve();
  let admitted: AdmittedCommand | null = null;

  const serialize = async <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return await next;
  };

  return {
    /**
     * Picks out, at the moment a stop arrives, the command of `turnId` that
     * is admitted now. Call synchronously on receipt; the returned function
     * aborts that command, and never one admitted later, once the stop's
     * sender has been verified.
     */
    stopTurn(turnId: string): () => void {
      const target = admitted?.turnId === turnId ? admitted : null;
      return () => {
        target?.stop.abort();
      };
    },
    /**
     * Aborts the admitted command, then applies `change` once that command
     * has unwound.
     */
    async change<T>(change: () => Promise<T>): Promise<T> {
      admitted?.stop.abort();
      return await serialize(change);
    },
    /**
     * Admits one web command at a time; another that arrives while one is
     * waiting or running is refused as busy. Call synchronously on receipt,
     * so a stop sent after the command always finds it.
     */
    async runCommand<T>(
      turnId: string,
      execute: (signal: AbortSignal) => Promise<T>,
    ): Promise<CommandOutcome<T>> {
      if (admitted !== null) {
        return { status: "busy" };
      }
      const command = { stop: new AbortController(), turnId };
      admitted = command;
      try {
        const result = await serialize(
          async () => await execute(command.stop.signal),
        );
        return { result, status: "completed" };
      } finally {
        admitted = null;
      }
    },
  };
};
