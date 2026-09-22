export const API_SHUTDOWN_OUTCOME = {
  drained: "drained",
  timedOut: "timed-out",
} as const;

type ApiShutdownOutcome =
  (typeof API_SHUTDOWN_OUTCOME)[keyof typeof API_SHUTDOWN_OUTCOME];

type ShutdownApiServicesOptions = {
  closeBackgroundWorkers: () => Promise<void>;
  drainScheduler: Promise<void> | undefined;
  onHttpStopError: (error: unknown) => void;
  stopHttp: () => Promise<void>;
  stopScheduler: () => void;
  stopSse: () => void;
  timeout: Promise<void>;
};

export const shutdownApiServices = async ({
  closeBackgroundWorkers,
  drainScheduler,
  onHttpStopError,
  stopHttp,
  stopScheduler,
  stopSse,
  timeout,
}: ShutdownApiServicesOptions): Promise<ApiShutdownOutcome> => {
  const httpStopped = stopHttp().catch(onHttpStopError);
  stopSse();
  stopScheduler();

  return await Promise.race([
    Promise.allSettled([
      httpStopped,
      drainScheduler,
      closeBackgroundWorkers(),
    ]).then(() => API_SHUTDOWN_OUTCOME.drained),
    timeout.then(() => API_SHUTDOWN_OUTCOME.timedOut),
  ]);
};
