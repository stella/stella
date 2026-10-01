const DROP_REPORT_INTERVAL_MS = 10_000;
const scheduleDropReport = (callback: () => void) => {
  const timer = setTimeout(callback, DROP_REPORT_INTERVAL_MS);
  timer.unref();
  return () => clearTimeout(timer);
};

type DropReporterOptions = {
  report: (dropped: number, cause?: unknown) => void;
  schedule?: (callback: () => void) => () => void;
};

// A counter and one representative cause bound telemetry during an outage.
export const createDropReporter = ({
  report,
  schedule = scheduleDropReport,
}: DropReporterOptions) => {
  let pending = 0;
  let cause: unknown;
  let cancel: (() => void) | undefined;
  const flush = () => {
    cancel?.();
    cancel = undefined;
    if (pending === 0) {
      return;
    }
    const dropped = pending;
    const failure = cause;
    pending = 0;
    cause = undefined;
    report(dropped, failure);
  };
  const add = (dropped: number, failure?: unknown) => {
    pending += dropped;
    cause ??= failure;
    cancel ??= schedule(flush);
  };
  return { add, flush };
};
