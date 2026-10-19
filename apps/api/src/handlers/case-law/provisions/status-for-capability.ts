import type { ProvisionLinkCapability } from "@stll/api-contract/provision-link-capability";
import type { ProvisionLinkStatus } from "@stll/api-contract/provision-link-status";

export const provisionStatusForCapability = (
  capability: ProvisionLinkCapability,
  status: ProvisionLinkStatus,
): ProvisionLinkStatus =>
  capability.type === "notSupportedYet" ? { type: "out_of_scope" } : status;
