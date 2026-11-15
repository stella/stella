import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, mock, test } from "bun:test";

import type { TaskTab } from "@/components/inspector/inspector-store-types";
import { taskTabDetailOptions } from "@/components/inspector/task-tab-query";

const countTaskRequests = async (tab: TaskTab) => {
  const queryClient = new QueryClient();
  const { enabled, queryKey } = taskTabDetailOptions(tab);
  const fetchTask = mock(async () => null);
  const observer = new QueryObserver(queryClient, {
    enabled,
    queryKey,
    queryFn: fetchTask,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  await queryClient.getQueryCache().find({ queryKey })?.promise;
  unsubscribe();
  queryClient.clear();
  return fetchTask.mock.calls.length;
};

const taskTab = (creationStatus: TaskTab["creationStatus"]): TaskTab => ({
  type: "task",
  id:
    creationStatus === "pending"
      ? "pending-task:5b0f6a52-3f43-4d5e-9d0e-0d6b8f3f9c1a"
      : "0b7c1e64-5f8a-4c3b-9e2d-7a6f4d3c2b1a",
  creationStatus,
  label: "New task",
  isNew: true,
  workspaceId: "8d4e2f1a-6b3c-4a5d-8e7f-9a0b1c2d3e4f",
});

describe("task tab detail requests", () => {
  test("a pending tab sends no request for its placeholder id", async () => {
    expect(await countTaskRequests(taskTab("pending"))).toBe(0);
  });

  test("a ready tab requests its task", async () => {
    expect(await countTaskRequests(taskTab("ready"))).toBe(1);
  });
});
