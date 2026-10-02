import { TaggedError } from "better-result";

/** The shutdown drain ended a chat turn run that could not store its outcome. */
class ChatTurnsUnsettledError extends TaggedError("ChatTurnsUnsettledError")<{
  message: string;
}> {}

export const API_SHUTDOWN_OUTCOME = {
  drained: "drained",
  failed: "failed",
  timedOut: "timed-out",
} as const;

type ApiShutdownOutcome =
  (typeof API_SHUTDOWN_OUTCOME)[keyof typeof API_SHUTDOWN_OUTCOME];

type ShutdownApiServicesOptions = {
  closeBackgroundWorkers: () => Promise<void>;
  closeManagedProviderChecks: () => Promise<void>;
  /** Undefined where the login check is not started (local runs). */
  closeDatabaseLoginProbe: (() => Promise<void>) | undefined;
  drainScheduler: Promise<void> | undefined;
  onHttpStopError: (error: unknown) => void;
  /**
   * Ends the chat turns this process produces, each storing what it has, so
   * none waits out its lease; their responses then end too.
   */
  relinquishChatTurnRuns: () => Promise<"stored" | "unstored">;
  stopHttp: () => Promise<void>;
  stopScheduler: () => void;
  stopSse: () => void;
  timeout: Promise<void>;
};

export const shutdownApiServices = async ({
  closeBackgroundWorkers,
  closeManagedProviderChecks,
  closeDatabaseLoginProbe,
  drainScheduler,
  onHttpStopError,
  relinquishChatTurnRuns,
  stopHttp,
  stopScheduler,
  stopSse,
  timeout,
}: ShutdownApiServicesOptions): Promise<ApiShutdownOutcome> => {
  const providerChecksClosed = closeManagedProviderChecks();
  const httpStopped = stopHttp().catch((error: unknown) => {
    onHttpStopError(error);
    throw error;
  });
  stopSse();
  stopScheduler();
  // A run that could not store its outcome leaves its turn to the reaper:
  // the drain did not end it.
  const chatTurnRunsRelinquished = relinquishChatTurnRuns().then(async (end) =>
    end === "stored"
      ? undefined
      : await Promise.reject(
          new ChatTurnsUnsettledError({
            message: "A chat turn run could not store its outcome",
          }),
        ),
  );

  return await Promise.race([
    Promise.allSettled([
      httpStopped,
      providerChecksClosed,
      chatTurnRunsRelinquished,
      drainScheduler,
      closeBackgroundWorkers(),
      closeDatabaseLoginProbe?.(),
    ]).then((results) =>
      results.some((result) => result.status === "rejected")
        ? API_SHUTDOWN_OUTCOME.failed
        : API_SHUTDOWN_OUTCOME.drained,
    ),
    timeout.then(() => API_SHUTDOWN_OUTCOME.timedOut),
  ]);
};
