import type {
  createHandoffStepUpGuard,
  HANDOFF_ACCESS_DETAIL,
} from "./handoff-step-up-policy";

type HandoffAccessMetadata = Parameters<typeof createHandoffStepUpGuard>[0];

declare module "elysia/types" {
  interface DocumentDecoration {
    [HANDOFF_ACCESS_DETAIL.accountAccess]?: HandoffAccessMetadata["accountAccess"];
    [HANDOFF_ACCESS_DETAIL.permissions]?: HandoffAccessMetadata["permissions"];
  }
}
