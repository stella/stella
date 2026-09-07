import { useId, useState } from "react";
import type { KeyboardEvent } from "react";

import { useQueries, useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { ChevronRightIcon, PlusIcon, Settings2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { isBusinessRegistryCredentialSlug } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Loader } from "@stll/ui/loader";
import { Menu, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { Separator } from "@stll/ui/separator";
import { cn } from "@stll/ui/utils";

import { FeedbackCommunityItems } from "@/components/feedback-community-items";
import { RegistryCredentialSetup } from "@/components/registry-credential-setup";
import {
  getRegistryQueryHint,
  REGISTRY_COUNTRY_GROUPS,
  resolveExpandedRegistryCountries,
} from "@/components/search-company-result.logic";
import type { RegistryHit } from "@/components/templates/registry-autofill";
import { businessRegistryConfigurationOptions } from "@/components/templates/registry-configuration-queries";
import { LOOKUP_REGISTRY_OPTIONS } from "@/components/templates/registry-options";
import { businessRegistryQueryOptions } from "@/components/templates/registry-queries";
import { useFormatter } from "@/i18n/formatting-context";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { organizationSettingsOptions } from "@/lib/organization/settings-queries";

export const useCompanyRegistrySearch = (
  query: string | null,
  visible: boolean,
) => {
  const user = useAuthenticatedUser();
  const organizationId = user.activeOrganizationId;
  const settings = useQuery({
    ...organizationSettingsOptions(organizationId),
    enabled: visible,
  });
  const configuration = useQuery(
    businessRegistryConfigurationOptions({ organizationId, enabled: visible }),
  );
  const [override, setOverride] = useState<{
    organizationId: string;
    countries: readonly string[];
  } | null>(null);
  const [selection, setSelection] = useState<{
    organizationId: string;
    query: string | null;
    registry: RegistryHit["registry"];
    id: string;
  } | null>(null);
  const jurisdictions = settings.data
    ? settings.data.practiceJurisdictions
    : [];
  const preferredCountry =
    jurisdictions.find((entry) => entry.isPrimary)?.countryCode ??
    jurisdictions.at(0)?.countryCode ??
    null;
  const expandedCountries = resolveExpandedRegistryCountries({
    preferredCountry,
    override,
    organizationId,
  });
  const requests = LOOKUP_REGISTRY_OPTIONS.flatMap((registry) => {
    if (!visible || !query || !expandedCountries.includes(registry.country)) {
      return [];
    }
    if (getRegistryQueryHint(registry.slug, query) !== null) {
      return [];
    }
    if (
      isBusinessRegistryCredentialSlug(registry.slug) &&
      configuration.data?.registries.find(
        (entry) => entry.registry === registry.slug,
      )?.status !== "ready"
    ) {
      return [];
    }
    return [
      {
        registry,
        options: businessRegistryQueryOptions({
          organizationId,
          registry: registry.slug,
          query,
        }),
      },
    ];
  });
  // Removing a collapsed country's observer also cancels its in-flight request.
  const results = useQueries({
    queries: requests.map((request) => request.options),
  });
  const resultsByRegistry = new Map(
    results.map((result, index) => {
      const request = requests.at(index);
      if (!request) {
        return panic("Registry query result has no request");
      }
      return [request.registry.slug, result] as const;
    }),
  );
  const groups = REGISTRY_COUNTRY_GROUPS.map((group) => ({
    country: group.country,
    expanded: expandedCountries.includes(group.country),
    registries: group.registries.map((registry) => {
      const result = resultsByRegistry.get(registry.slug);
      const data = result?.data;
      let hits: RegistryHit[] = [];
      if (data?.type === "lookup" && data.hit !== null) {
        hits = [data.hit];
      }
      if (data?.type === "search") {
        hits = data.hits;
      }
      return {
        registry,
        configuration: configuration.data?.registries.find(
          (entry) => entry.registry === registry.slug,
        ),
        hits,
        result,
        queryHint: getRegistryQueryHint(registry.slug, query),
      };
    }),
  }));
  const hits = groups.flatMap((group) =>
    group.registries.flatMap((registry) => registry.hits),
  );
  const selectedHit =
    (selection?.organizationId === organizationId && selection.query === query
      ? hits.find(
          (hit) =>
            hit.id === selection.id && hit.registry === selection.registry,
        )
      : undefined) ??
    hits.at(0) ??
    null;
  const selectHit = (hit: RegistryHit) =>
    setSelection({ organizationId, query, registry: hit.registry, id: hit.id });
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      !visible ||
      query === null ||
      hits.length === 0 ||
      (event.key !== "ArrowDown" && event.key !== "ArrowUp")
    ) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    const current = hits.findIndex(
      (hit) =>
        hit.id === selectedHit?.id && hit.registry === selectedHit.registry,
    );
    const next = hits.at(
      (current + (event.key === "ArrowDown" ? 1 : -1) + hits.length) %
        hits.length,
    );
    if (next) {
      selectHit(next);
    }
    return true;
  };
  return {
    visible,
    groups,
    selectedHit,
    selectHit,
    onSearchKeyDown,
    settings,
    configuration,
    organizationId,
    toggleCountry: (country: string) =>
      setOverride({
        organizationId,
        countries: expandedCountries.includes(country)
          ? expandedCountries.filter((entry) => entry !== country)
          : [...expandedCountries, country],
      }),
  };
};

type CompanySearch = ReturnType<typeof useCompanyRegistrySearch>;

export const SearchCompanyResult = ({
  search,
  onSelect,
}: {
  search: CompanySearch;
  onSelect?: () => void;
}) => {
  const t = useTranslations();
  if (!search.visible) {
    return null;
  }
  return (
    <section
      className="space-y-1 px-2 py-2"
      aria-label={t("search.registryChoose")}
    >
      {search.settings.isLoading && (
        <Loader label={t("common.loading")} size="sm" />
      )}
      {search.settings.error && (
        <RegistrySearchError
          error={search.settings.error}
          onRetry={() =>
            detached(search.settings.refetch(), "search-company.settings-retry")
          }
        />
      )}
      {search.configuration.error && (
        <RegistrySearchError
          error={search.configuration.error}
          onRetry={() =>
            detached(
              search.configuration.refetch(),
              "search-company.configuration-retry",
            )
          }
        />
      )}
      {search.groups.map((group) => (
        <RegistryCountryGroup
          key={group.country}
          group={group}
          search={search}
          onSelect={onSelect}
        />
      ))}
      <Separator className="my-2" />
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              className="min-h-11 w-full justify-start gap-2 px-2"
            />
          }
        >
          <PlusIcon className="size-4" />
          {t("search.requestCountry")}
        </MenuTrigger>
        <MenuPopup align="start">
          <FeedbackCommunityItems />
        </MenuPopup>
      </Menu>
    </section>
  );
};

const RegistryCountryGroup = ({
  group,
  search,
  onSelect,
}: {
  group: CompanySearch["groups"][number];
  search: CompanySearch;
  onSelect: (() => void) | undefined;
}) => {
  const id = useId();
  const format = useFormatter();
  const t = useTranslations();
  return (
    <section>
      <div className="hover:bg-accent focus-within:bg-accent flex items-center rounded-md">
        <Button
          variant="ghost"
          className="min-h-11 min-w-0 flex-1 justify-start gap-2 px-2 text-start data-pressed:bg-transparent [:hover,[data-pressed]]:bg-transparent"
          aria-expanded={group.expanded}
          aria-controls={id}
          onClick={() => search.toggleCountry(group.country)}
        >
          <DirectionalIcon
            icon={ChevronRightIcon}
            flip={!group.expanded}
            className={cn("size-4 shrink-0", group.expanded && "rotate-90")}
          />
          <span>{format.displayName(group.country, { type: "region" })}</span>
          <span className="text-muted-foreground ms-auto truncate text-xs font-normal">
            <bdi>
              {group.registries.map((entry) => entry.registry.name).join(", ")}
            </bdi>
          </span>
        </Button>
        {group.registries.map((entry) =>
          isBusinessRegistryCredentialSlug(entry.registry.slug) &&
          entry.configuration ? (
            <Popover key={entry.registry.slug}>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 shrink-0 data-pressed:bg-transparent [:hover,[data-pressed]]:bg-transparent"
                    aria-label={`${t("common.settings")} · ${entry.registry.name}`}
                  />
                }
              >
                <Settings2Icon className="size-4" />
              </PopoverTrigger>
              <PopoverPopup layer="search-child" align="end" className="w-80">
                <p className="px-3 text-sm font-medium">
                  <bdi>{entry.registry.name}</bdi>
                </p>
                <RegistryCredentialSetup
                  key={`${search.organizationId}:${entry.registry.slug}`}
                  registry={entry.registry.slug}
                  source={entry.configuration.source}
                />
              </PopoverPopup>
            </Popover>
          ) : null,
        )}
      </div>
      <div id={id}>
        {group.expanded && (
          <div className="space-y-2 ps-6 pb-2">
            {group.registries.map((entry) => (
              <RegistrySearchResults
                key={entry.registry.slug}
                entry={entry}
                search={search}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
};

const RegistrySearchResults = ({
  entry,
  search,
  onSelect,
}: {
  entry: CompanySearch["groups"][number]["registries"][number];
  search: CompanySearch;
  onSelect: (() => void) | undefined;
}) => {
  const t = useTranslations();
  return (
    <div className="space-y-1" aria-label={entry.registry.name}>
      {entry.queryHint && (
        <p className="text-muted-foreground py-2 text-sm" role="status">
          {t(entry.queryHint)}
        </p>
      )}
      {entry.result?.isLoading && (
        <Loader label={t("common.loading")} size="sm" />
      )}
      {entry.result?.error && (
        <RegistrySearchError
          error={entry.result.error}
          onRetry={() => {
            if (entry.result) {
              detached(entry.result.refetch(), "search-company.retry");
            }
          }}
        />
      )}
      {entry.result?.isSuccess && entry.hits.length === 0 && (
        <p className="text-muted-foreground py-2 text-sm">
          {t("common.noResults")}
        </p>
      )}
      {entry.hits.map((hit) => {
        const selected =
          search.selectedHit?.id === hit.id &&
          search.selectedHit.registry === hit.registry;
        const select = () => {
          search.selectHit(hit);
          onSelect?.();
        };
        return (
          <Button
            key={hit.id}
            variant={selected ? "secondary" : "ghost"}
            className="h-auto min-h-14 w-full justify-start px-3 py-3 text-start"
            aria-pressed={selected}
            onClick={select}
            onFocus={select}
          >
            <span className="min-w-0 flex-1 space-y-1">
              <span className="block truncate font-medium" dir="auto">
                {hit.name}
              </span>
              <span className="text-muted-foreground block truncate text-xs font-normal">
                <bdi>{hit.id}</bdi>
                {hit.address?.textAddress && (
                  <>
                    {" "}
                    · <bdi>{hit.address.textAddress}</bdi>
                  </>
                )}
              </span>
            </span>
          </Button>
        );
      })}
    </div>
  );
};

const RegistrySearchError = ({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) => {
  const t = useTranslations();
  return (
    <div role="alert" className="space-y-2 py-2">
      <p className="text-muted-foreground text-sm">
        {userErrorFromThrown(error, t("common.somethingWentWrong"))}
      </p>
      <Button variant="ghost" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </div>
  );
};
