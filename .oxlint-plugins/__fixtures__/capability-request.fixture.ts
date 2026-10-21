// Relative imports: the rule resolves `@/` against the importing app, and this
// fixture lives outside apps/web.
import { api } from "../../apps/web/src/lib/api.ts";
import { invokeCapability } from "../../apps/web/src/lib/capabilities/capability-request.ts";
import { useCapabilityMutation } from "../../apps/web/src/lib/capabilities/use-capability-mutation.ts";

declare const body: { title: string };
declare const capability: "chat.threads.update";

// expect-clean: capability-request/capability-request
await invokeCapability(
  "chat.threads.update",
  async (request) =>
    await api.chat.threads({ threadId: "thread" }).patch(body, request),
);
await invokeCapability(
  "chat.threads.update",
  async () =>
    // oxlint-disable-next-line capability-request/capability-request
    await api.chat.threads({ threadId: "thread" }).patch(body),
);
// oxlint-disable-next-line capability-request/capability-request
await invokeCapability(
  capability,
  async (request) =>
    await api.chat.threads({ threadId: "thread" }).patch(body, request),
);
export const useFixtureMutation = () =>
  // expect-clean: capability-request/capability-request
  useCapabilityMutation({
    capability: "chat.threads.update",
    mutationFn: async (next: typeof body, request) =>
      await api.chat.threads({ threadId: "thread" }).patch(next, request),
  });
