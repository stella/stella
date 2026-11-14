import type { SseStreamBinding } from "@/api/lib/sse";

/** A credential that always holds, for tests whose subject is not the binding. */
export const HELD_TEST_STREAM_BINDING: SseStreamBinding = {
  kind: "credential",
  revalidate: async () => await Promise.resolve(true),
};
