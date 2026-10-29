import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";

import {
  BUSINESS_REGISTRY_SEARCH_CAPABILITIES,
  type BusinessRegistrySlug,
} from "@stll/api-contract";
import type {
  DesktopRegistryConfig,
  DesktopRegistryDefaultFormat,
  DesktopRegistrySearchResponse,
  DesktopRegistrySearchResult,
} from "@stll/api-contract/desktop-registry";
import { BUSINESS_REGISTRY_FORMAT_CAPABILITIES } from "@stll/business-registries/default-formats";
import { mapWithConcurrency } from "@stll/concurrency";

import type { ScopedDb } from "@/api/db/safe-db";
import { templateLookupFormats } from "@/api/db/schema";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import {
  getOrganizationRegistryDispatch,
  getOrganizationRegistryHandler,
} from "@/api/lib/business-registries/credentials";
import {
  BUSINESS_REGISTRY_SLUGS,
  type BusinessRegistryHit,
  executeRegistryLookup,
  type LoadRegistryWebSearch,
  NO_REGISTRY_WEB_SEARCH,
} from "@/api/lib/business-registries/dispatch";
import { loadPracticeJurisdictions } from "@/api/lib/db/practice-jurisdictions";
import {
  isPlausibleLookupValue,
  renderLookupOutput,
  stripLookupMarkdown,
} from "@/api/lib/docx/lookup-fields";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { resolveLookupFormatDefault } from "@/api/lib/templates/lookup-formats/resolve-default";
import { setLookupFormatUserDefault } from "@/api/lib/templates/lookup-formats/set-user-default";
import {
  ACTION_COST_CALL_KIND,
  actionRequestObserver,
} from "@/api/lib/usage/action-costs/context";
import { loadWebSearchProvidersForOrg } from "@/api/lib/web-search/load-org-keys";

import { getDefaultDesktopRegistry } from "./default-registry";

const SEARCH_LIMIT = 12;
const FORMAT_LIMIT = 100;
const DETAIL_CONCURRENCY = 3;

export type DesktopRegistryContext = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  scopedDb: ScopedDb;
  testDependencies?: {
    getOrganizationRegistryHandler?: typeof getOrganizationRegistryHandler;
    loadWebSearch?: LoadRegistryWebSearch;
    loadFormats?: typeof loadFormats;
  };
};

type DesktopRegistrySearch = {
  registry: BusinessRegistrySlug;
  query: string;
};

const invalidRegistry = () =>
  new HandlerError({ status: 400, message: "Unsupported business registry" });

const loadFormats = async (
  { organizationId, scopedDb, userId }: DesktopRegistryContext,
  registry: BusinessRegistrySlug,
) => {
  const [rows, defaultRow] = await Promise.all([
    scopedDb((tx) =>
      tx
        .select({
          id: templateLookupFormats.id,
          name: templateLookupFormats.name,
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
    // The member's own choice wins over the firm's; the resolver owns that
    // order for every surface that renders a lookup.
    scopedDb(async (tx) =>
      (
        await resolveLookupFormatDefault({
          tx,
          organizationId,
          registry,
          userId,
        })
      ).unwrap("A resolver given an open transaction fails by throwing"),
    ),
  ]);
  const formatRows =
    defaultRow && !rows.some((row) => row.id === defaultRow.id)
      ? [defaultRow, ...rows.slice(0, FORMAT_LIMIT - 1)]
      : rows;
  return {
    formats: formatRows.map(({ id, name }) => ({ id, name })),
    defaultFormatId: defaultRow?.id ?? null,
    defaultFormatSource: defaultRow?.source ?? null,
    defaultFormat: defaultRow?.format ?? null,
  };
};

export const getDesktopRegistryConfig = async (
  context: DesktopRegistryContext,
): Promise<Result<DesktopRegistryConfig, HandlerError>> => {
  // Practice jurisdictions only pick the default registry; the desktop offers
  // every deployable registry so a lookup abroad never needs a settings change.
  const practiceJurisdictions = await loadPracticeJurisdictions(context);
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
    return handler.isDeployAvailable()
      ? {
          id,
          name: `${handler.country} · ${handler.displayName}`,
          formatType: BUSINESS_REGISTRY_FORMAT_CAPABILITIES[id].type,
          searchCapabilities: BUSINESS_REGISTRY_SEARCH_CAPABILITIES[id],
        }
      : null;
  });
  const enabledRegistries = registries.filter((entry) => entry !== null);
  return Result.ok({
    registries: enabledRegistries,
    defaultRegistryId: getDefaultDesktopRegistry({
      registries: enabledRegistries,
      practiceJurisdictions,
    }),
  });
};

export const searchDesktopRegistry = async (
  context: DesktopRegistryContext,
  { registry, query: rawQuery }: DesktopRegistrySearch,
): Promise<Result<DesktopRegistrySearchResponse, HandlerError>> => {
  const observer = actionRequestObserver(
    context.organizationId,
    ACTION_COST_CALL_KIND.registryRequest,
  );
  const query = rawQuery.trim();
  if (query.length === 0 || query.length > 256) {
    return Result.err(invalidRegistry());
  }
  const configured = await Result.tryPromise({
    try: async () =>
      await (
        context.testDependencies?.getOrganizationRegistryHandler ??
        getOrganizationRegistryHandler
      )({
        ...context,
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
  if (!configured.value.isDeployAvailable()) {
    return Result.err(
      new HandlerError({
        status: 428,
        code: "registry_configuration_required",
        message: "Business registry configuration is required",
      }),
    );
  }
  const loadWebSearch: LoadRegistryWebSearch =
    context.testDependencies?.loadWebSearch ??
    (async () =>
      await Result.tryPromise({
        try: async () => {
          const { webSearchProvider } = await context.scopedDb(async (tx) =>
            loadWebSearchProvidersForOrg(tx, context.organizationId),
          );
          return webSearchProvider === null
            ? null
            : {
                provider: webSearchProvider,
                observer: actionRequestObserver(
                  context.organizationId,
                  ACTION_COST_CALL_KIND.webSearchRequest,
                ).onRequest,
              };
        },
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Could not load web search configuration",
            cause,
          }),
      }));
  const lookup = await executeRegistryLookup({
    loadWebSearch,
    observer,
    permit: grantThirdPartyOutboundPermit(),
    handler: configured.value,
    query,
    limit: SEARCH_LIMIT,
  });
  if (lookup instanceof HandlerError) {
    return Result.err(lookup);
  }
  if (lookup.type === "name-search-unavailable") {
    return Result.err(
      new HandlerError({
        status: 502,
        code: "upstream_unavailable",
        retryable: true,
        message: "Business registry name search is unavailable",
      }),
    );
  }
  const formats = await (context.testDependencies?.loadFormats ?? loadFormats)(
    context,
    registry,
  );
  const results: DesktopRegistrySearchResult[] = [];
  const toResult = (hit: BusinessRegistryHit): DesktopRegistrySearchResult => {
    const rendered = renderLookupOutput(formats.defaultFormat, hit);
    return {
      id: hit.id,
      name: hit.name,
      text: stripLookupMarkdown(rendered),
      rendered,
    };
  };
  if (lookup.type === "lookup") {
    if (lookup.hit !== null) {
      results.push(toResult(lookup.hit));
    }
  } else if (lookup.type === "search") {
    const detailed = await mapWithConcurrency({
      items: lookup.hits.slice(0, SEARCH_LIMIT),
      limit: DETAIL_CONCURRENCY,
      operation: async (hit) => {
        if (
          formats.defaultFormat === null &&
          BUSINESS_REGISTRY_FORMAT_CAPABILITIES[registry].resultShape ===
            "search-result"
        ) {
          return Result.ok(hit);
        }
        const detail = await executeRegistryLookup({
          loadWebSearch,
          observer,
          permit: grantThirdPartyOutboundPermit(),
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
              code: "internal_error",
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
      results.push(toResult(result.value));
    }
  }
  return Result.ok({
    formats: formats.formats,
    defaultFormatId: formats.defaultFormatId,
    defaultFormatSource: formats.defaultFormatSource,
    results,
  });
};

type DesktopRegistrySetDefaultFormat = {
  registry: BusinessRegistrySlug;
  formatId: SafeId<"templateLookupFormat"> | null;
};

/**
 * Save or clear the caller's own default format and answer with the default
 * they now resolve to. Clearing a personal choice is not "no default": the
 * organization's default takes over, and the desktop has to show that one
 * rather than wait for the next search to contradict it.
 */
export const setDesktopRegistryDefaultFormat = async (
  { organizationId, scopedDb, userId }: DesktopRegistryContext,
  { registry, formatId }: DesktopRegistrySetDefaultFormat,
): Promise<Result<DesktopRegistryDefaultFormat, HandlerError>> =>
  (
    await Result.tryPromise({
      try: async () =>
        await scopedDb(async (tx) => {
          const saved = await setLookupFormatUserDefault({
            tx,
            organizationId,
            userId,
            registry,
            formatId,
          });
          if (saved.isErr()) {
            return saved;
          }
          return Result.ok(
            (
              await resolveLookupFormatDefault({
                tx,
                organizationId,
                registry,
                userId,
              })
            ).unwrap("A resolver given an open transaction fails by throwing"),
          );
        }),
      catch: (cause) =>
        new HandlerError({
          status: 503,
          code: "internal_error",
          message: "Could not save the default format",
          cause,
        }),
    })
  )
    .andThen((saved) => saved)
    .map((resolved) => ({
      defaultFormatId: resolved?.id ?? null,
      defaultFormatSource: resolved?.source ?? null,
    }));

type DesktopRegistryFormat = {
  registry: BusinessRegistrySlug;
  id: string;
  formatId: SafeId<"templateLookupFormat"> | null;
};

export const formatDesktopRegistry = async (
  context: DesktopRegistryContext,
  { registry, id: rawId, formatId }: DesktopRegistryFormat,
): Promise<Result<{ text: string; rendered: string }, HandlerError>> => {
  const observer = actionRequestObserver(
    context.organizationId,
    ACTION_COST_CALL_KIND.registryRequest,
  );
  const id = rawId.trim();
  if (
    id.length === 0 ||
    id.length > 64 ||
    !isPlausibleLookupValue(registry, id)
  ) {
    return Result.err(invalidRegistry());
  }
  const format =
    formatId === null
      ? null
      : await context
          .scopedDb((tx) =>
            tx
              .select({ format: templateLookupFormats.format })
              .from(templateLookupFormats)
              .where(
                and(
                  eq(templateLookupFormats.id, formatId),
                  eq(
                    templateLookupFormats.organizationId,
                    context.organizationId,
                  ),
                  eq(templateLookupFormats.registry, registry),
                ),
              )
              .limit(1),
          )
          .then((rows) => rows.at(0) ?? null);
  if (formatId !== null && !format) {
    return Result.err(
      new HandlerError({ status: 404, message: "Saved format not found" }),
    );
  }
  const configured = await Result.tryPromise({
    try: async () =>
      await getOrganizationRegistryHandler({
        ...context,
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
    loadWebSearch: NO_REGISTRY_WEB_SEARCH,
    observer,
    permit: grantThirdPartyOutboundPermit(),
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
  const rendered = renderLookupOutput(format?.format ?? null, lookup.hit);
  return Result.ok({ text: stripLookupMarkdown(rendered), rendered });
};
