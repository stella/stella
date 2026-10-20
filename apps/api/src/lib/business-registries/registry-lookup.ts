import { Result } from "better-result";

import type { BusinessRegistryLookupDetail } from "@stll/api-contract";
import type { RegistryRequestObservation } from "@stll/business-registries/shared/request-observer";

import type { ScopedDb } from "@/api/db/safe-db";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import { getOrganizationRegistryHandler } from "@/api/lib/business-registries/credentials";
import { executeRegistryLookup } from "@/api/lib/business-registries/dispatch";
import type {
  BusinessRegistrySlug,
  RegistryLookupResponse,
} from "@/api/lib/business-registries/dispatch";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { WebSearchRequestObserver } from "@/api/lib/web-search/search";
import type { WebSearchProvider } from "@/api/lib/web-search/types";

type LookupBusinessRegistryProps = {
  observer: RegistryRequestObservation;
  permit: ThirdPartyOutboundPermit;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  registry: BusinessRegistrySlug;
  q: string;
  detail?: BusinessRegistryLookupDetail | undefined;
  executeLookup?: typeof executeRegistryLookup | undefined;
  webSearchProvider?: WebSearchProvider | null | undefined;
  observeWebSearch?: WebSearchRequestObserver | undefined;
};

// Native-tool preferences control discovery, not access to public records.
export const lookupBusinessRegistryShared = async ({
  observer,
  permit,
  scopedDb,
  organizationId,
  registry,
  q,
  detail,
  executeLookup = executeRegistryLookup,
  webSearchProvider,
  observeWebSearch = () => undefined,
}: LookupBusinessRegistryProps): Promise<
  Result<RegistryLookupResponse, HandlerError>
> => {
  const configured = await Result.tryPromise({
    try: async () =>
      await getOrganizationRegistryHandler({
        scopedDb,
        organizationId,
        registry,
      }),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Could not load registry configuration",
        cause,
      }),
  });
  if (configured.isErr()) {
    return Result.err(configured.error);
  }
  const handler = configured.value;
  if (!handler.isDeployAvailable()) {
    return Result.err(
      new HandlerError({
        status: 428,
        code: "registry_configuration_required",
        message: `Configure credentials for the '${registry}' registry before searching`,
      }),
    );
  }

  const result = await executeLookup({
    handler,
    query: q,
    detail,
    observer,
    permit,
    ...(webSearchProvider
      ? {
          webSearch: {
            provider: webSearchProvider,
            observer: observeWebSearch,
          },
        }
      : {}),
  });
  if (result instanceof HandlerError) {
    return Result.err(result);
  }
  return Result.ok(result);
};
