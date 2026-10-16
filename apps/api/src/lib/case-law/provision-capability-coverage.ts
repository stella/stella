import { panic } from "better-result";

import { PROVISION_LINK_CAPABILITIES } from "@stll/api-contract/provision-link-capability";
import type { ProvisionLinkCapability } from "@stll/api-contract/provision-link-capability";

import type {
  ADAPTER_MANIFESTS,
  IMPORT_SOURCE_MANIFESTS,
} from "@/api/lib/legal-search/adapter-manifest";

type RegisteredJurisdiction =
  | (typeof ADAPTER_MANIFESTS)[keyof typeof ADAPTER_MANIFESTS]["country"]
  | (typeof IMPORT_SOURCE_MANIFESTS)[keyof typeof IMPORT_SOURCE_MANIFESTS]["country"];

const registeredCapabilities = PROVISION_LINK_CAPABILITIES satisfies Record<
  RegisteredJurisdiction,
  ProvisionLinkCapability
>;

export const checkProvisionCapabilityCoverage = (
  sources: readonly { country: string; language?: string }[],
  capabilities: Readonly<
    Record<string, ProvisionLinkCapability>
  > = registeredCapabilities,
): void => {
  for (const source of sources) {
    const capability = capabilities[source.country];
    if (capability === undefined) {
      panic(`Missing provision capability for ${source.country}`);
    }
    if (
      capability.type === "supported" &&
      source.language !== undefined &&
      !capability.languages.includes(source.language)
    ) {
      panic(
        `Missing provision language capability for ${source.country}/${source.language}`,
      );
    }
  }
};
