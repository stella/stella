import {
  createLazyRedisClient,
  createRedisClient,
} from "@/api/lib/redis-client";
import { createWorkflowRunStateStore } from "@/api/lib/workflow/run-state-store";

// The store binds one connection for its lifetime, and this one is the
// process-wide instance every workflow path reaches for. Bind it to the
// holder rather than to a client, so a connection that closes is replaced on
// the next command instead of stranding the store on a dead socket.
const rootRedis = createLazyRedisClient(() => createRedisClient());

const sendRootCommand = async (
  command: string,
  args: string[],
): Promise<unknown> => {
  const reply: unknown = await (await rootRedis.ready()).send(command, args);
  return reply;
};

let rootWorkflowRunStateStore: ReturnType<
  typeof createWorkflowRunStateStore
> | null = null;

export const getRootWorkflowRunStateStore = () => {
  rootWorkflowRunStateStore ??= createWorkflowRunStateStore({
    send: sendRootCommand,
  });
  return rootWorkflowRunStateStore;
};
