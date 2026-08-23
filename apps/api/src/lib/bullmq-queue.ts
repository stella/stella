import { Queue } from "bullmq";
import type { QueueOptions } from "bullmq";
import type { RedisOptions } from "bun";

import { createBullMqConnection } from "@/api/lib/redis-client";

type LazyBullMqQueueOptions = Omit<QueueOptions, "connection"> & {
  connectionOptions?: RedisOptions;
  name: string;
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
