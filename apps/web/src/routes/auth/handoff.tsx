import { createFileRoute, redirect } from "@tanstack/react-router";
import { panic } from "better-result";

import { handoffConfirmation } from "@/lib/account/mcp-handoff";

import { HandoffPage } from "./-handoff.page";
import { HandoffPending } from "./-handoff.pending";

export const Route = createFileRoute("/auth/handoff")({
  ssr: false,
  beforeLoad: () => {
    const confirmation = handoffConfirmation();
    if (!confirmation) {
      redirect({ to: "/auth", replace: true, throw: true });
      return panic("TanStack Router did not throw the sign-in redirect.");
    }
    return { confirmation };
  },
  head: () => ({ meta: [{ name: "referrer", content: "no-referrer" }] }),
  component: HandoffPage,
  pendingComponent: HandoffPending,
});
