import { QueryClient } from "@tanstack/react-query";
import { expect, spyOn, test } from "bun:test";

import type { ChatLocalRunStepContent } from "@stll/api-contract/chat-local-run-step-content";

import { toSafeId } from "@/lib/safe-id";

import { localRunStepOutputOptions } from "./local-run-step-output";

test("a step query follows response offsets and combines command windows", async () => {
  const queryClient = new QueryClient();
  const starts: string[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (...[input, init]: Parameters<typeof globalThis.fetch>) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const start = url.searchParams.get("start") ?? "";
        starts.push(start);
        signals.push(init?.signal);
        return Response.json({
          state: "stored",
          kind: "command",
          totalBytes: 6,
          storedBytes: 6,
          start: Number(start),
          text: start === "0" ? "abc" : "def",
          nextStart: start === "0" ? 3 : null,
        } satisfies ChatLocalRunStepContent);
      },
      { preconnect: () => undefined },
    ),
  );
  try {
    const result = await queryClient.query(
      localRunStepOutputOptions({
        activeOrganizationId: "organization",
        userId: "member",
        threadId: toSafeId<"chatThread">("thread"),
        callId: "call",
      }),
    );
    expect(result).toEqual({
      status: "text",
      kind: "command",
      text: "abcdef",
      readBytes: 6,
      storedBytes: 6,
      totalBytes: 6,
    });
    expect(starts).toEqual(["0", "3"]);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  } finally {
    fetch.mockRestore();
    queryClient.clear();
  }
});
