import { Queue } from "bullmq";
import type { QueueOptions } from "bullmq";

import {
  createBullMqConnection,
  type RedisClientOverrides,
} from "@/api/lib/redis-client";

type LazyBullMqQueueOptions = Omit<QueueOptions, "connection"> & {
  connectionOptions?: RedisClientOverrides;
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
