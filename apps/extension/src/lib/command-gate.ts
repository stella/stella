export const createCommandGate = () => {
  let running = false;

  return {
    async run<T>(
      execute: () => Promise<T>,
    ): Promise<{ result: T; status: "completed" } | { status: "busy" }> {
      if (running) {
        return { status: "busy" };
      }
      running = true;
      try {
        return { result: await execute(), status: "completed" };
      } finally {
        running = false;
      }
    },
  };
};
