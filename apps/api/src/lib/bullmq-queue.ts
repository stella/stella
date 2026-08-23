import { Queue } from "bullmq";
import type { QueueOptions } from "bullmq";

import { createBullMqConnection } from "@/api/lib/redis-client";

type LazyBullMqQueueOptions = Omit<QueueOptions, "connection"> & {
  createConnection?: () => ReturnType<typeof createBullMqConnection>;
  name: string;
};

export const createLazyBullMqQueue = <DataType>({
  createConnection = createBullMqConnection,
  name,
  ...options
}: LazyBullMqQueueOptions) => {
  let connection: ReturnType<typeof createBullMqConnection> | null = null;
  let queue: Queue<DataType> | null = null;

  return () => {
    connection ??= createConnection();
    queue ??= new Queue<DataType>(name, {
      ...options,
      connection,
    });
    return queue;
  };
};
