import { Result } from "better-result";
import { createHash } from "node:crypto";

import {
  BUSINESS_REGISTRY_CONFIGURATION,
  BUSINESS_REGISTRY_CREDENTIAL_SLUGS,
  isBusinessRegistryCredentialSlug,
} from "@stll/api-contract";
import type { BusinessRegistrySlug } from "@stll/api-contract";
import { CompaniesHouseAuthError } from "@stll/business-registries/companies-house";
import { DenueAuthError } from "@stll/business-registries/denue";

import type { ScopedDb } from "@/api/db/safe-db";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import type { SafeId } from "@/api/lib/branded-types";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import type { RegistryHandler } from "@/api/lib/business-registries/dispatch";
import { decryptContent, encryptContent } from "@/api/lib/content-encryption";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

// Provider secrets must never use content-encryption's local plaintext envelope.
export const encryptRegistryCredential = async (
  organizationId: SafeId<"organization">,
  credential: string,
) => {
  if (!envDocumentProcessingWorker.CONTENT_ENCRYPTION_KEY) {
    return Result.err(
      new HandlerError({
        status: 503,
        code: "registry_secret_storage_unavailable",
        message: "Secure credential storage is not configured on this server",
      }),
    );
  }
  return await Result.tryPromise({
    try: async () => await encryptContent(organizationId, credential),
    catch: () =>
      new HandlerError({
        status: 500,
        message: "Could not secure registry credentials",
      }),
  });
};

export const bindRegistryCredential = (
  handler: RegistryHandler,
  credential: string,
): RegistryHandler => {
  const search = handler.search;
  return {
    ...handler,
    isDeployAvailable: () => handler.isDeployAvailable(credential),
    lookup: async (input) => await handler.lookup(input, credential),
    search:
      search === null
        ? null
        : async (input, options) =>
            await search(input, { ...options, credential }),
    mapError: (error) => {
      if (
        error instanceof CompaniesHouseAuthError ||
        error instanceof DenueAuthError
      ) {
        return new HandlerError({
          status: 400,
          code: "registry_credentials_rejected",
          message: "The registry rejected the configured credentials",
        });
      }
      const mapped = handler.mapError(error);
      // Upstream errors can contain credential-bearing URLs (DENUE).
      return new HandlerError({
        status: mapped?.status ?? 502,
        code: "registry_request_failed",
        message: `The ${handler.slug} registry request failed. Check the identifier and configured credentials, or retry later.`,
      });
    },
  };
};

type OrganizationRegistryOptions = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
};

export const getOrganizationRegistryDispatch = async ({
  scopedDb,
  organizationId,
}: OrganizationRegistryOptions) => {
  const rows = await scopedDb((tx) =>
    tx.query.businessRegistryCredentials.findMany({
      where: { organizationId: { eq: organizationId } },
      limit: BUSINESS_REGISTRY_CREDENTIAL_SLUGS.length,
    }),
  );
  const dispatch = { ...BUSINESS_REGISTRY_DISPATCH };
  const configured = await Promise.all(
    rows.map(async (row) => ({
      registry: row.registry,
      credential: await decryptContent(organizationId, row.ciphertext, row.iv),
      version: createHash("sha256").update(row.ciphertext).digest("hex"),
    })),
  );
  for (const entry of configured) {
    dispatch[entry.registry] = {
      ...bindRegistryCredential(dispatch[entry.registry], entry.credential),
      cacheVersion: entry.version,
    };
  }
  return dispatch;
};

export const getOrganizationRegistryHandler = async ({
  registry,
  ...context
}: OrganizationRegistryOptions & { registry: BusinessRegistrySlug }) => {
  if (!isBusinessRegistryCredentialSlug(registry)) {
    return BUSINESS_REGISTRY_DISPATCH[registry];
  }
  const dispatch = await getOrganizationRegistryDispatch(context);
  return dispatch[registry];
};

export const getOrganizationRegistryAvailability = async (
  context: OrganizationRegistryOptions,
) => {
  const dispatch = await getOrganizationRegistryDispatch(context);
  return (registry: BusinessRegistrySlug) =>
    dispatch[registry].isDeployAvailable();
};

export const registryConfigurationStatus = (
  registry: BusinessRegistrySlug,
  organizationConfigured: boolean,
) => {
  const configuration = BUSINESS_REGISTRY_CONFIGURATION[registry];
  if (configuration === "none") {
    return {
      registry,
      configuration,
      status: "ready",
      source: "public",
    } as const;
  }
  if (organizationConfigured) {
    return {
      registry,
      configuration,
      status: "ready",
      source: "organization",
    } as const;
  }
  if (BUSINESS_REGISTRY_DISPATCH[registry].isDeployAvailable()) {
    return {
      registry,
      configuration,
      status: "ready",
      source: "deployment",
    } as const;
  }
  return {
    registry,
    configuration,
    status: "configuration-required",
    source: null,
  } as const;
};
