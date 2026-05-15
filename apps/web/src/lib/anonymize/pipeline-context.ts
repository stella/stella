export const createPipelineContextRunner = () => {
  let pipelineQueue: Promise<void> = Promise.resolve();

  return async <T>(task: () => Promise<T>): Promise<T> => {
    const run = pipelineQueue.then(task, task);
    pipelineQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  };
};
