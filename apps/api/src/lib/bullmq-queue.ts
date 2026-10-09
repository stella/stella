import { Result, TaggedError } from "better-result";
import { Job, Queue, UnrecoverableError, Worker } from "bullmq";
import type { JobProgress, QueueOptions } from "bullmq";

import type { rootDb } from "@/api/db/root";
import { captureError } from "@/api/lib/analytics/capture";
import {
  createBullMqConnection,
  type RedisClientOverrides,
} from "@/api/lib/redis-client";

const QUEUE_JOB_FAILED_MESSAGE = "Queue job failed";

class QueueJobFailedError extends TaggedError("QueueJobFailedError")<{
  message: string;
}> {
  constructor() {
    super({ message: QUEUE_JOB_FAILED_MESSAGE });
    this.stack = "";
  }
}

const storedQueueFailure = (error: unknown) => {
  // BullMQ treats this class/name as terminal, regardless of the retry budget.
  if (
    Result.try(
      () =>
        error instanceof UnrecoverableError ||
        (error instanceof Error && error.name === "UnrecoverableError"),
    ).unwrapOr(false)
  ) {
    const terminal = new UnrecoverableError(QUEUE_JOB_FAILED_MESSAGE);
    terminal.stack = "";
    return terminal;
  }
  return new QueueJobFailedError();
};

class QueueFailureJob<
  DataType = unknown,
  ResultType = unknown,
  NameType extends string = string,
  ProgressType extends JobProgress = JobProgress,
> extends Job<DataType, ResultType, NameType, ProgressType> {
  override async moveToFailed(
    error: Error,
    token: string,
    fetchNext?: boolean,
  ) {
    // Clear traces from earlier attempts before BullMQ serializes the job.
    this.stacktrace = [];
    return await super.moveToFailed(
      storedQueueFailure(error),
      token,
      fetchNext,
    );
  }
}

/**
 * Job failure records carry a fixed message and no stack. Worker events retain
 * the original error, so failure observation and finalization keep their evidence.
 */
export class BullMqWorker<
  DataType = unknown,
  ResultType = void,
  NameType extends string = string,
> extends Worker<DataType, ResultType, NameType> {
  protected override get Job() {
    return QueueFailureJob;
  }
}

/**
 * Every BullMQ queue and the process that hosts its worker. The union this
 * table defines is what `createLazyBullMqQueue` accepts and what each host's
 * worker set must cover exactly (see `createBullMqWorkerHost`), so a queue
 * cannot be added without deciding where its worker runs, and a host cannot
 * start without it.
 */
export const BULLMQ_QUEUE_HOSTS = {
  "account-deletion-cleanup": "api",
  "bilingual-translation-runs": "api",
  "document-deadline-scouts": "api",
  "document-processing": "document-processing-worker",
  "document-review-runs-v2": "api",
  "document-translation-runs": "api",
  "entity-deletion-cleanup": "api",
  "file-derivatives": "api",
  "flow-run": "api",
  "legal-list-verification-runs": "api",
  "report-exports": "api",
  "style-set-package-cleanup": "api",
  "uploaded-mail-correspondence": "api",
  workflow: "api",
  "workflow-flex": "api",
} as const satisfies Record<string, BullMqWorkerHost>;

export type BullMqWorkerHost = "api" | "document-processing-worker";

export type BullMqQueueName = keyof typeof BULLMQ_QUEUE_HOSTS;

/** Queue names whose worker the given host must start. */
type BullMqQueueHostedBy<Host extends BullMqWorkerHost> = {
  [Name in BullMqQueueName]: (typeof BULLMQ_QUEUE_HOSTS)[Name] extends Host
    ? Name
    : never;
}[BullMqQueueName];

/**
 * What a host hands every worker it starts. The host owns the postgres-role
 * connection and passes it down, so no queue module imports it; tests inject
 * a structurally equivalent handle.
 */
export type BullMqWorkerContext = {
  db: typeof rootDb;
};

/**
 * Starts a worker, or a group sharing one lifecycle, and reports the queues
 * it consumes. `queues` must come from the same constant handed to the BullMQ
 * `Worker`, so the host check below binds each queue to the code that drains it.
 */
export type BullMqWorkerStarter = (context: BullMqWorkerContext) => {
  queues: readonly BullMqQueueName[];
  close: () => Promise<void>;
};

type QueuesOf<Starters extends readonly BullMqWorkerStarter[]> = ReturnType<
  Starters[number]
>["queues"][number];

/**
 * Resolves to `unknown` when the starters cover exactly the queues the host
 * owns; otherwise to an object the starter array cannot satisfy, whose key
 * names the mismatch and whose value names the queue.
 */
type BullMqHostCoverage<
  Host extends BullMqWorkerHost,
  Starters extends readonly BullMqWorkerStarter[],
> = ([Exclude<BullMqQueueHostedBy<Host>, QueuesOf<Starters>>] extends [never]
  ? unknown
  : {
      missingWorkerForQueue: Exclude<
        BullMqQueueHostedBy<Host>,
        QueuesOf<Starters>
      >;
    }) &
  ([Exclude<QueuesOf<Starters>, BullMqQueueHostedBy<Host>>] extends [never]
    ? unknown
    : {
        queueHostedElsewhere: Exclude<
          QueuesOf<Starters>,
          BullMqQueueHostedBy<Host>
        >;
      });

/**
 * The one switch for background writers. `disabled` starts no worker at all,
 * for any host and any queue, so a worker added later is off in a seeded stack
 * without anyone remembering to list it.
 */
export type BullMqWorkerHostMode = "enabled" | "disabled";

type BullMqWorkerHostHandle = {
  /** Drains every worker. A failed close is captured, never thrown. */
  close: () => Promise<void>;
};

export const createBullMqWorkerHost = <
  Host extends BullMqWorkerHost,
  const Starters extends readonly BullMqWorkerStarter[],
>(
  host: Host,
  context: BullMqWorkerContext,
  mode: BullMqWorkerHostMode,
  starters: Starters & BullMqHostCoverage<Host, Starters>,
): BullMqWorkerHostHandle => {
  if (mode === "disabled") {
    return { close: async () => {} };
  }
  const running = starters.map((start) => start(context));
  return {
    close: async () => {
      await Promise.all(
        running.map(async ({ queues, close }) => {
          const closed = await Result.tryPromise({
            try: async () => await close(),
            catch: (cause) => cause,
          });
          if (Result.isError(closed)) {
            captureError(closed.error, { host, queues: queues.join(",") });
          }
        }),
      );
    },
  };
};

type LazyBullMqQueueOptions = Omit<QueueOptions, "connection"> & {
  connectionOptions?: RedisClientOverrides;
  name: BullMqQueueName;
};

export const createLazyBullMqQueue = <DataType>({
  connectionOptions,
  name,
  ...options
}: LazyBullMqQueueOptions) => {
  let connection: ReturnType<typeof createBullMqConnection> | null = null;
  let queue: Queue<DataType> | null = null;

  return () => {
    connection ??= createBullMqConnection({
      storeClass: "durable-coordination",
      overrides: connectionOptions,
    });
    queue ??= new Queue<DataType>(name, {
      ...options,
      connection,
    });
    return queue;
  };
};
