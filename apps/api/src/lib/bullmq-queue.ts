import { Result } from "better-result";
import { Queue } from "bullmq";
import type { QueueOptions } from "bullmq";

import type { rootDb } from "@/api/db/root";
import { captureError } from "@/api/lib/analytics/capture";
import {
  createBullMqConnection,
  type RedisClientOverrides,
} from "@/api/lib/redis-client";

/**
 * Every BullMQ queue and the process that hosts its worker. The union this
 * table defines is what `createLazyBullMqQueue` accepts and what each host's
 * worker set must cover exactly (see `createBullMqWorkerHost`), so a queue
 * cannot be added without deciding where its worker runs, and a host cannot
 * start without it.
 */
const BULLMQ_QUEUE_HOSTS = {
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
  starters: Starters & BullMqHostCoverage<Host, Starters>,
): BullMqWorkerHostHandle => {
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
    connection ??= createBullMqConnection(connectionOptions);
    queue ??= new Queue<DataType>(name, {
      ...options,
      connection,
    });
    return queue;
  };
};
