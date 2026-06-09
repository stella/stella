import { useEffect, useMemo, useState } from "react";

import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  GlobeIcon,
  GraduationCapIcon,
  LoaderIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { EU_MEMBER_STATES } from "@stll/catalogue";
import { Button } from "@stll/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/components/input-group";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import {
  CatalogueRow,
  type CatalogueRowDisplay,
} from "@/components/catalogue/catalogue-row";
import type { ContextMenuAction } from "@/components/context-menu";
import { useInspectorStore } from "@/components/inspector/inspector-store";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import { McpIcon } from "@/components/mcp-icon";
import type { TranslationKey } from "@/i18n/types";
import type { PracticeJurisdiction } from "@/lib/jurisdictions";
import { roleOptions } from "@/routes/-queries";
import {
  BlueprintGallerySheet,
  type BlueprintCreatedSkill,
} from "@/routes/_protected.knowledge/-components/blueprint-gallery-sheet";
import { knowledgeKeys } from "@/routes/_protected.knowledge/-queries";
import {
  catalogueKeys,
  catalogueOptions,
} from "@/routes/_protected.knowledge/-queries/catalogue";

import { AddMcpServerSheet } from "./add-mcp-server-sheet";
import { isEffectivelyInstalled, type CatalogueEntry } from "./catalogue-types";
import { InstallPackButton } from "./install-pack-button";
import { toolDetailTabId } from "./tool-detail-view";
import { useInstallEntry } from "./use-install-entry";
import { useUninstallEntry } from "./use-uninstall-entry";

export type CatalogueBrowserFilterKind = "all" | "skill" | "mcp";

const KIND_LABEL_KEY = {
  all: "common.all",
  skill: "catalogue.filter.skills",
  mcp: "catalogue.filter.mcps",
} as const satisfies Record<CatalogueBrowserFilterKind, TranslationKey>;

const FILTERS: readonly CatalogueBrowserFilterKind[] = ["all", "skill", "mcp"];

type CatalogueBrowserProps = {
  organizationId: string;
  /** Initial kind filter (e.g. from `?kind=mcp` on the unified surface). */
  initialKind?: CatalogueBrowserFilterKind | undefined;
  /**
   * When true, render the "Add custom" dropdown in the toolbar. Disabled
   * for the onboarding flow.
   */
  showAddCustom?: boolean;
  /**
   * Seeds the jurisdiction filter so a CZ-based user lands on Tools and
   * sees only CZ + EU entries by default. Mirrors the onboarding step.
   * Universal entries (no jurisdictions) always pass.
   */
  practiceJurisdictions?: readonly PracticeJurisdiction[];
};

const toRowDisplay = (entry: CatalogueEntry): CatalogueRowDisplay => ({
  slug: entry.slug,
  displayName: entry.displayName,
  description: entry.description,
  author: entry.author,
  cost: entry.cost,
  setup: entry.setup,
  icon: entry.icon,
  iconUrl: entry.iconUrl,
  jurisdictions: entry.jurisdictions,
});

export const CatalogueBrowser = ({
  organizationId,
  initialKind,
  showAddCustom = true,
  practiceJurisdictions,
}: CatalogueBrowserProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const { data } = useSuspenseQuery(catalogueOptions(organizationId));
  const { data: role } = useQuery(roleOptions);
  // Match the backend gate: only admins/owners can create MCP
  // connectors (see `POST /mcp/connectors`). Members would see the
  // form open and the submit 403, so hide the affordance entirely.
  const canAddCustom = role === "admin" || role === "owner";
  const [filter, setFilter] = useState<CatalogueBrowserFilterKind>(
    initialKind ?? "all",
  );
  const [query, setQuery] = useState("");
  const inspector = useInspectorView();
  // Active tool-detail tab in the inspector → focused slug for the
  // row highlight. One source of truth; closing the inspector tab
  // clears the highlight automatically.
  const focusedTabId = useInspectorStore((s) => {
    const active = s.tabs.find((tab) => tab.id === s.activeId);
    if (active === undefined || active.type !== "view") {
      return null;
    }
    if (active.viewType !== "tool-detail") {
      return null;
    }
    return active.id;
  });
  // Pre-populate from the user's practice + "EU" when at least one
  // practice country is an EU-27 member. Mirrors the onboarding
  // catalogue step.
  const [jurisdictionFilter, setJurisdictionFilter] = useState<Set<string>>(
    () => {
      const initial = new Set<string>();
      if (!practiceJurisdictions) {
        return initial;
      }
      let touchesEu = false;
      for (const jurisdiction of practiceJurisdictions) {
        const code = jurisdiction.countryCode.toUpperCase();
        initial.add(code);
        if (EU_MEMBER_STATES.has(code)) {
          touchesEu = true;
        }
      }
      if (touchesEu) {
        initial.add("EU");
      }
      return initial;
    },
  );
  const [jurisdictionQuery, setJurisdictionQuery] = useState("");
  const [addMcpOpen, setAddMcpOpen] = useState(false);
  const [blueprintGalleryOpen, setBlueprintGalleryOpen] = useState(false);
  // Reuse `role` from the canAddCustom block above for team-skill gating.
  const canManageTeam = role === "admin" || role === "owner";

  useEffect(() => {
    if (initialKind !== undefined) {
      setFilter(initialKind);
    }
  }, [initialKind]);

  const entries = data.entries;

  const filtered = useMemo(() => {
    const normalised = query.trim().toLowerCase();
    const subset = entries.filter((entry) => {
      if (filter !== "all" && entry.kind !== filter) {
        return false;
      }
      if (
        jurisdictionFilter.size > 0 &&
        entry.jurisdictions.length > 0 &&
        !entry.jurisdictions.some((code) => jurisdictionFilter.has(code))
      ) {
        return false;
      }
      if (normalised === "") {
        return true;
      }
      return (
        entry.displayName.toLowerCase().includes(normalised) ||
        entry.description.toLowerCase().includes(normalised) ||
        entry.tags.some((tag) => tag.toLowerCase().includes(normalised))
      );
    });
    return [...subset].sort((left, right) => {
      if (left.isRecommendedForOrg !== right.isRecommendedForOrg) {
        return left.isRecommendedForOrg ? -1 : 1;
      }
      return left.displayName.localeCompare(right.displayName);
    });
  }, [entries, filter, jurisdictionFilter, query]);

  const allJurisdictionCodes = useMemo(() => {
    const set = new Set<string>();
    for (const entry of entries) {
      for (const code of entry.jurisdictions) {
        set.add(code);
      }
    }
    return [...set].sort();
  }, [entries]);

  const onRowFocus = (entry: CatalogueEntry) => {
    const tabId = toolDetailTabId(entry.kind, entry.slug);
    if (focusedTabId === tabId) {
      inspector.close(tabId);
      return;
    }
    inspector.open({
      type: "tool-detail",
      id: tabId,
      label: entry.displayName,
      payload: {
        kind: entry.kind,
        slug: entry.slug,
        organizationId,
        iconHint: {
          icon: entry.icon,
          iconUrl: entry.iconUrl ?? null,
        },
      },
      ownerRouteId: "/_protected/knowledge/tools",
    });
  };

  const queryClient = useQueryClient();
  const onSkillSheetChanged = () => {
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.skills.all(organizationId),
    });
    void queryClient.invalidateQueries({
      queryKey: catalogueKeys.list(organizationId),
    });
  };

  // A blueprint instantiates a disabled draft; drop the user straight into the
  // full-screen editor route to customise and publish it.
  const onBlueprintCreated = (skill: BlueprintCreatedSkill) => {
    onSkillSheetChanged();
    void navigate({
      to: "/knowledge/tools/$skillId",
      params: { skillId: skill.id },
    });
  };

  const openEditInstalledSkill = (entry: CatalogueEntry) => {
    if (entry.kind !== "skill" || entry.installedSkillId === null) {
      return;
    }
    void navigate({
      to: "/knowledge/tools/$skillId",
      params: { skillId: entry.installedSkillId },
    });
  };

  const recommendedFiltered = filtered.filter(
    (entry) => entry.isRecommendedForOrg,
  );
  const otherFiltered = filtered.filter((entry) => !entry.isRecommendedForOrg);
  const hasMcpEntries = entries.some((entry) => entry.kind === "mcp");
  // On a truly empty MCP catalogue, replace the generic "no entries" + reset
  // line with a prominent add-MCP call to action. Gated to admins/owners
  // like the add-custom menu, since members can't create connectors.
  const showMcpEmptyCta = filter === "mcp" && !hasMcpEntries && canAddCustom;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <InputGroup className="flex-1">
          <InputGroupAddon>
            <SearchIcon className="text-muted-foreground" />
          </InputGroupAddon>
          <InputGroupInput
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("onboarding.catalogueSearchPlaceholder")}
            value={query}
          />
          {query.length > 0 && (
            <InputGroupAddon align="inline-end">
              <Button
                aria-label={t("onboarding.catalogueClearSearch")}
                onClick={() => setQuery("")}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </InputGroupAddon>
          )}
        </InputGroup>
        <Popover>
          <PopoverTrigger
            render={
              <Button className="shrink-0" type="button" variant="outline" />
            }
          >
            <GlobeIcon className="size-3.5" />
            {jurisdictionFilter.size === 0
              ? t("common.all")
              : [...jurisdictionFilter].sort().join(", ")}
            <ChevronDownIcon className="size-3.5" />
          </PopoverTrigger>
          <PopoverPopup align="end" className="w-60" side="bottom">
            <div className="border-border border-b p-2">
              <InputGroup>
                <InputGroupAddon>
                  <SearchIcon className="text-muted-foreground" />
                </InputGroupAddon>
                <InputGroupInput
                  autoFocus
                  onChange={(e) => setJurisdictionQuery(e.target.value)}
                  placeholder={t("common.search")}
                  size="sm"
                  value={jurisdictionQuery}
                />
              </InputGroup>
            </div>
            <div className="flex max-h-[260px] flex-col overflow-y-auto p-1">
              {jurisdictionQuery.trim() === "" && (
                <>
                  <button
                    aria-pressed={jurisdictionFilter.size === 0}
                    className="hover:bg-muted flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors"
                    onClick={() => setJurisdictionFilter(new Set())}
                    type="button"
                  >
                    <span
                      className={cn(
                        "border-border flex size-4 items-center justify-center rounded-sm border",
                        jurisdictionFilter.size === 0 &&
                          "border-foreground bg-foreground",
                      )}
                    >
                      {jurisdictionFilter.size === 0 && (
                        <CheckIcon className="text-background size-3" />
                      )}
                    </span>
                    <span className="text-foreground font-medium">
                      {t("common.all")}
                    </span>
                  </button>
                  <div className="bg-border my-1 h-px" />
                </>
              )}
              {(() => {
                const matches = allJurisdictionCodes.filter((code) =>
                  code
                    .toLowerCase()
                    .includes(jurisdictionQuery.trim().toLowerCase()),
                );
                if (matches.length === 0) {
                  return (
                    <p className="text-muted-foreground px-2 py-3 text-center text-xs">
                      {t("common.noResults")}
                    </p>
                  );
                }
                return matches.map((code) => {
                  const active = jurisdictionFilter.has(code);
                  return (
                    <button
                      aria-pressed={active}
                      className="hover:bg-muted flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors"
                      key={code}
                      onClick={() =>
                        setJurisdictionFilter((prev) => {
                          const next = new Set(prev);
                          if (next.has(code)) {
                            next.delete(code);
                          } else {
                            next.add(code);
                          }
                          return next;
                        })
                      }
                      type="button"
                    >
                      <span
                        className={cn(
                          "border-border flex size-4 items-center justify-center rounded-sm border",
                          active && "border-foreground bg-foreground",
                        )}
                      >
                        {active && (
                          <CheckIcon className="text-background size-3" />
                        )}
                      </span>
                      <span className="text-foreground">{code}</span>
                    </button>
                  );
                });
              })()}
            </div>
          </PopoverPopup>
        </Popover>
        {showAddCustom && canAddCustom && (
          <Menu>
            <MenuTrigger render={<Button className="shrink-0" type="button" />}>
              <PlusIcon className="size-3.5" />
              {t("catalogue.addCustom")}
              <ChevronDownIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="w-56">
              <MenuItem onClick={() => setAddMcpOpen(true)}>
                <McpIcon className="size-4" />
                {t("catalogue.addCustomMcp")}
              </MenuItem>
              <MenuItem onClick={() => setBlueprintGalleryOpen(true)}>
                <GraduationCapIcon className="size-4" />
                {t("catalogue.addCustomSkill")}
              </MenuItem>
            </MenuPopup>
          </Menu>
        )}
      </div>

      {jurisdictionFilter.size > 0 && (
        <p className="text-muted-foreground -mt-3 text-xs">
          {t("catalogue.filterHint", {
            codes: [...jurisdictionFilter].sort().join(", "),
          })}{" "}
          <button
            className="hover:text-foreground underline underline-offset-2"
            onClick={() => setJurisdictionFilter(new Set())}
            type="button"
          >
            {t("common.showAll")}
          </button>
        </p>
      )}

      <div className="flex items-center gap-1.5">
        {FILTERS.map((option) => (
          <button
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium",
              filter === option
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted",
            )}
            key={option}
            onClick={() => setFilter(option)}
            type="button"
          >
            {t(KIND_LABEL_KEY[option])}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        {filtered.length === 0 && !showMcpEmptyCta && (
          <p className="text-muted-foreground text-sm">
            {t("catalogue.empty")}
          </p>
        )}
        {showMcpEmptyCta && (
          <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
            <McpIcon className="text-muted-foreground size-8" />
            <Button onClick={() => setAddMcpOpen(true)} type="button">
              <PlusIcon className="size-4" />
              {t("catalogue.addCustomMcp")}
            </Button>
          </div>
        )}
        {recommendedFiltered.length > 0 && (
          <>
            <div className="mb-1 flex items-center justify-between gap-3">
              <h2 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                {t("catalogue.sectionRecommended")}
              </h2>
              {(() => {
                const installableInView = recommendedFiltered.filter(
                  (entry) => entry.installState === "available",
                );
                if (installableInView.length === 0) {
                  return null;
                }
                return (
                  <InstallPackButton
                    entries={installableInView}
                    organizationId={organizationId}
                  />
                );
              })()}
            </div>
            {recommendedFiltered.map((entry) => (
              <CatalogueEntryRow
                entry={entry}
                focused={
                  focusedTabId === toolDetailTabId(entry.kind, entry.slug)
                }
                key={`${entry.kind}-${entry.slug}`}
                onEditSkill={() => openEditInstalledSkill(entry)}
                onFocus={() => onRowFocus(entry)}
                organizationId={organizationId}
              />
            ))}
          </>
        )}
        {otherFiltered.length > 0 && (
          <h2
            className={cn(
              "text-muted-foreground mb-1 text-xs font-medium tracking-wider uppercase",
              recommendedFiltered.length > 0 && "mt-4",
            )}
          >
            {t("catalogue.sectionOthers")}
          </h2>
        )}
        {otherFiltered.map((entry) => (
          <CatalogueEntryRow
            entry={entry}
            focused={focusedTabId === toolDetailTabId(entry.kind, entry.slug)}
            key={`${entry.kind}-${entry.slug}`}
            onEditSkill={() => openEditInstalledSkill(entry)}
            onFocus={() => onRowFocus(entry)}
            organizationId={organizationId}
          />
        ))}
        {/* Reset-all live at the bottom of the list whenever a
            filter is hiding entries. Always there, regardless of
            whether the filtered subset is empty or partial — the
            user's question is the same: "where's the rest?". */}
        {entries.length - filtered.length > 0 && !showMcpEmptyCta && (
          <div className="flex justify-center pt-2">
            <Button
              onClick={() => {
                setQuery("");
                setJurisdictionFilter(new Set());
                setFilter("all");
              }}
              size="sm"
              type="button"
              variant="link"
            >
              {t("common.showAll")} ({entries.length - filtered.length})
            </Button>
          </div>
        )}
      </div>

      <AddMcpServerSheet
        onOpenChange={setAddMcpOpen}
        open={addMcpOpen}
        organizationId={organizationId}
      />
      <BlueprintGallerySheet
        canManageTeam={canManageTeam}
        onCreated={onBlueprintCreated}
        onOpenChange={setBlueprintGalleryOpen}
        open={blueprintGalleryOpen}
      />
    </div>
  );
};

type CatalogueEntryRowProps = {
  entry: CatalogueEntry;
  focused: boolean;
  onEditSkill: () => void;
  onFocus: () => void;
  organizationId: string;
};

const CatalogueEntryRow = ({
  entry,
  focused,
  onEditSkill,
  onFocus,
  organizationId,
}: CatalogueEntryRowProps) => {
  const t = useTranslations();
  const install = useInstallEntry(organizationId);
  const uninstall = useUninstallEntry(entry, organizationId);

  const effectivelyInstalled = isEffectivelyInstalled(entry);
  const installable =
    !effectivelyInstalled && entry.installState !== "unavailable";
  const canRemove =
    effectivelyInstalled &&
    !entry.isLocked &&
    (entry.kind === "native-tool" ||
      (entry.kind === "mcp" && entry.installedConnectorSlug !== null) ||
      (entry.kind === "skill" && entry.installedSkillId !== null));

  const onInstall = () => {
    install.mutate(entry, {
      onSuccess: () => {
        stellaToast.add({
          title: t("catalogue.installed", { name: entry.displayName }),
          type: "success",
        });
      },
      onError: (error) => {
        stellaToast.add({
          title:
            error instanceof Error
              ? error.message
              : t("catalogue.installFailed"),
          type: "error",
        });
      },
    });
  };

  const contextActions: ContextMenuAction[] = [];
  if (
    effectivelyInstalled &&
    entry.kind === "skill" &&
    entry.installedSkillId !== null
  ) {
    contextActions.push({
      label: t("knowledge.agentSkills.editSkill"),
      onClick: onEditSkill,
    });
  }

  let actions: React.ReactNode = null;
  if (installable) {
    actions = (
      <Button
        disabled={install.isPending}
        onClick={(e) => {
          e.stopPropagation();
          onInstall();
        }}
        size="xs"
        type="button"
        variant="outline"
      >
        {install.isPending && <LoaderIcon className="size-3.5 animate-spin" />}
        {t("common.add")}
      </Button>
    );
  } else if (canRemove) {
    actions = (
      <Button
        disabled={uninstall.isPending}
        onClick={(e) => {
          e.stopPropagation();
          uninstall.mutate();
        }}
        size="xs"
        type="button"
        variant="destructive-outline"
      >
        {uninstall.isPending && (
          <LoaderIcon className="size-3.5 animate-spin" />
        )}
        {t("common.remove")}
      </Button>
    );
  } else if (effectivelyInstalled) {
    // Locked baseline tool — installed but the user can't remove it
    // (e.g. anonymisation that gates AI access).
    actions = (
      <span
        aria-label={t("catalogue.installedShort")}
        className="text-muted-foreground inline-flex items-center gap-1 text-xs"
        title={t("catalogue.installedShort")}
      >
        <CheckIcon className="size-3.5" />
      </span>
    );
  } else if (entry.installState === "unavailable") {
    actions = (
      <span className="text-muted-foreground text-xs">
        {t("catalogue.unavailable")}
      </span>
    );
  }

  return (
    <CatalogueRow
      actions={actions}
      contextActions={contextActions}
      display={toRowDisplay(entry)}
      focused={focused}
      onFocus={onFocus}
    />
  );
};
