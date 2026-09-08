import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";

import { isBusinessRegistrySlug } from "@stll/api-contract";
import type { BusinessRegistrySlug } from "@stll/api-contract";
import type {
  DesktopRegistryConfig,
  DesktopRegistrySearchResponse,
  DesktopRegistrySearchResult,
} from "@stll/api-contract/desktop-registry";
import { mapWithConcurrency } from "@stll/concurrency";

import type { ScopedDb } from "@/api/db/safe-db";
import { templateLookupFormats } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  getOrganizationRegistryDispatch,
  getOrganizationRegistryHandler,
} from "@/api/lib/business-registries/credentials";
import {
  BUSINESS_REGISTRY_DISPATCH,
  BUSINESS_REGISTRY_SLUGS,
  executeRegistryLookup,
} from "@/api/lib/business-registries/dispatch";
import {
  isPlausibleLookupValue,
  renderLookupOutput,
  stripLookupMarkdown,
} from "@/api/lib/docx/lookup-fields";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isNativeToolEnabledForOrg } from "@/api/lib/mcp-connectors/catalog-metadata";

import { getDefaultDesktopRegistry } from "./default-registry";

const SEARCH_LIMIT = 12;
const FORMAT_LIMIT = 100;
const DETAIL_CONCURRENCY = 3;

export type DesktopRegistryContext = {
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
};

export type DesktopRegistrySearch = {
  registry: BusinessRegistrySlug;
  query: string;
};

const invalidRegistry = () =>
  new HandlerError({ status: 400, message: "Unsupported business registry" });

const loadSettings = async ({
  organizationId,
  scopedDb,
}: DesktopRegistryContext) =>
  await scopedDb((tx) =>
    tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: organizationId } },
      columns: { practiceJurisdictions: true, nativeToolOverrides: true },
    }),
  );

const registryIsEnabled = async (
  context: DesktopRegistryContext,
  registry: BusinessRegistrySlug,
) => {
  const settings = await loadSettings(context);
  return isNativeToolEnabledForOrg({
    slug: BUSINESS_REGISTRY_DISPATCH[registry].nativeToolSlug,
    practiceJurisdictions: settings?.practiceJurisdictions ?? [],
    nativeToolOverrides: settings?.nativeToolOverrides ?? {},
  });
};

const loadFormats = async (
  { organizationId, scopedDb }: DesktopRegistryContext,
  registry: BusinessRegistrySlug,
) => {
  const [rows, defaults] = await Promise.all([
    scopedDb((tx) =>
      tx
        .select({
          id: templateLookupFormats.id,
          name: templateLookupFormats.name,
          preference: templateLookupFormats.preference,
        })
        .from(templateLookupFormats)
        .where(
          and(
            eq(templateLookupFormats.organizationId, organizationId),
            eq(templateLookupFormats.registry, registry),
          ),
        )
        .orderBy(desc(templateLookupFormats.id))
        .limit(FORMAT_LIMIT),
    ),
    scopedDb((tx) =>
      tx
        .select({
          id: templateLookupFormats.id,
          name: templateLookupFormats.name,
          format: templateLookupFormats.format,
        })
        .from(templateLookupFormats)
        .where(
          and(
            eq(templateLookupFormats.organizationId, organizationId),
            eq(templateLookupFormats.registry, registry),
            eq(templateLookupFormats.preference, "default"),
          ),
        )
        .limit(1),
    ),
  ]);
  const defaultRow = defaults.at(0);
  const formatRows =
    defaultRow && !rows.some((row) => row.id === defaultRow.id)
      ? [defaultRow, ...rows.slice(0, FORMAT_LIMIT - 1)]
      : rows;
  return {
    formats: formatRows.map(({ id, name }) => ({ id, name })),
    defaultFormatId: defaultRow?.id ?? null,
    defaultFormat: defaultRow?.format ?? null,
  };
};

export const getDesktopRegistryConfig = async (
  context: DesktopRegistryContext,
): Promise<Result<DesktopRegistryConfig, HandlerError>> => {
  const settings = await loadSettings(context);
  const dispatchResult = await Result.tryPromise({
    try: async () => await getOrganizationRegistryDispatch(context),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Could not load registry configuration",
        cause,
      }),
  });
  if (dispatchResult.isErr()) {
    return Result.err(dispatchResult.error);
  }
  const registries = BUSINESS_REGISTRY_SLUGS.flatMap((id) => {
    const handler = dispatchResult.value[id];
    if (
      !isNativeToolEnabledForOrg({
        slug: handler.nativeToolSlug,
        practiceJurisdictions: settings?.practiceJurisdictions ?? [],
        nativeToolOverrides: settings?.nativeToolOverrides ?? {},
      })
    ) {
      return null;
    }
    return handler.isDeployAvailable()
      ? { id, name: handler.displayName }
      : null;
  });
  const enabledRegistries = registries.filter((entry) => entry !== null);
  return Result.ok({
    registries: enabledRegistries,
    defaultRegistryId: getDefaultDesktopRegistry({
      registries: enabledRegistries,
      practiceJurisdictions: settings?.practiceJurisdictions ?? [],
    }),
  });
};

export const searchDesktopRegistry = async (
  context: DesktopRegistryContext,
  input: { registry: unknown; query: string },
): Promise<Result<DesktopRegistrySearchResponse, HandlerError>> => {
  const query = input.query.trim();
  if (!isBusinessRegistrySlug(input.registry)) {
    return Result.err(invalidRegistry());
  }
  if (query.length === 0 || query.length > 256) {
    return Result.err(invalidRegistry());
  }
  if (!(await registryIsEnabled(context, input.registry))) {
    return Result.err(
      new HandlerError({
        status: 403,
        message: "Business registry is not enabled",
      }),
    );
  }
  const configured = await Result.tryPromise({
    try: async () =>
      await getOrganizationRegistryHandler({
        ...context,
        registry: input.registry,
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
  if (!configured.value.isDeployAvailable()) {
    return Result.err(
      new HandlerError({
        status: 428,
        code: "registry_configuration_required",
        message: "Business registry configuration is required",
      }),
    );
  }
  const lookup = await executeRegistryLookup({
    handler: configured.value,
    query,
    limit: SEARCH_LIMIT,
  });
  if (lookup instanceof HandlerError) {
    return Result.err(lookup);
  }
  const formats = await loadFormats(context, input.registry);
  const results: DesktopRegistrySearchResult[] = [];
  if (lookup.type === "lookup") {
    if (lookup.hit !== null) {
      results.push({
        id: lookup.hit.id,
        name: lookup.hit.name,
        text: stripLookupMarkdown(
          renderLookupOutput(formats.defaultFormat, lookup.hit),
        ),
      });
    }
  } else {
    const detailed = await mapWithConcurrency({
      items: lookup.hits.slice(0, SEARCH_LIMIT),
      limit: DETAIL_CONCURRENCY,
      operation: async (hit) => {
        if (formats.defaultFormat === null && input.registry !== "ares") {
          return Result.ok(hit);
        }
        const detail = await executeRegistryLookup({
          handler: configured.value,
          query: hit.id,
        });
        if (detail instanceof HandlerError) {
          return Result.err(detail);
        }
        if (detail.type !== "lookup" || !detail.hit) {
          return Result.err(
            new HandlerError({
              status: 502,
              message: "Could not format a registry result",
            }),
          );
        }
        return Result.ok(detail.hit);
      },
    });
    for (const result of detailed) {
      if (result.isErr()) {
        return Result.err(result.error);
      }
      results.push({
        id: result.value.id,
        name: result.value.name,
        text: stripLookupMarkdown(
          renderLookupOutput(formats.defaultFormat, result.value),
        ),
      });
    }
  }
  return Result.ok({
    formats: formats.formats,
    defaultFormatId: formats.defaultFormatId,
    results,
  });
};

export const formatDesktopRegistry = async (
  context: DesktopRegistryContext,
  input: {
    registry: unknown;
    id: string;
    formatId: string | null;
  },
): Promise<Result<{ text: string }, HandlerError>> => {
  if (!isBusinessRegistrySlug(input.registry)) {
    return Result.err(invalidRegistry());
  }
  const id = input.id.trim();
  if (
    id.length === 0 ||
    id.length > 64 ||
    !isPlausibleLookupValue(input.registry, id) ||
    !(await registryIsEnabled(context, input.registry))
  ) {
    return Result.err(invalidRegistry());
  }
  const format =
    input.formatId === null
      ? null
      : await context
          .scopedDb((tx) =>
            tx
              .select({ format: templateLookupFormats.format })
              .from(templateLookupFormats)
              .where(
                and(
                  eq(templateLookupFormats.id, input.formatId),
                  eq(
                    templateLookupFormats.organizationId,
                    context.organizationId,
                  ),
                  eq(templateLookupFormats.registry, input.registry),
                ),
              )
              .limit(1),
          )
          .then((rows) => rows.at(0) ?? null);
  if (input.formatId !== null && !format) {
    return Result.err(
      new HandlerError({ status: 404, message: "Saved format not found" }),
    );
  }
  const configured = await Result.tryPromise({
    try: async () =>
      await getOrganizationRegistryHandler({
        ...context,
        registry: input.registry,
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
  if (!configured.value.isDeployAvailable()) {
    return Result.err(
      new HandlerError({
        status: 428,
        code: "registry_configuration_required",
        message: "Business registry configuration is required",
      }),
    );
  }
  const lookup = await executeRegistryLookup({
    handler: configured.value,
    query: id,
  });
  if (lookup instanceof HandlerError) {
    return Result.err(lookup);
  }
  if (lookup.type !== "lookup" || lookup.hit === null) {
    return Result.err(
      new HandlerError({ status: 404, message: "Company not found" }),
    );
  }
  return Result.ok({
    text: stripLookupMarkdown(
      renderLookupOutput(format?.format ?? null, lookup.hit),
    ),
  });
};

