import type { ComponentProps } from "react";

import { HandoffConfirmationPanel } from "@/components/auth/handoff-confirmation-panel";

const confirmation = {
  email: "reader@example.test",
  organizationName: "Example legal team",
  submissionStatus: "ready",
  onConfirm: () => undefined,
  onCancel: () => undefined,
} satisfies ComponentProps<typeof HandoffConfirmationPanel>;

export const HandoffConfirmationPlayground = () => (
  <HandoffConfirmationPanel {...confirmation} />
);
