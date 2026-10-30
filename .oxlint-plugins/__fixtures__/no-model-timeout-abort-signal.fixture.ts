declare const generateTanStackObjectForTask: (options: unknown) => unknown;

generateTanStackObjectForTask({
  // oxlint-disable-next-line no-model-timeout-abort-signal/no-model-timeout-abort-signal -- detector fixture
  abortSignal: AbortSignal.timeout(1000),
});

generateTanStackObjectForTask({
  // oxlint-disable-next-line no-model-timeout-abort-signal/no-model-timeout-abort-signal -- detector fixture
  abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(1000)]),
});

// expect-clean: no-model-timeout-abort-signal/no-model-timeout-abort-signal
generateTanStackObjectForTask({
  abortSignal: request.signal,
  deadlineMs: 1000,
});
