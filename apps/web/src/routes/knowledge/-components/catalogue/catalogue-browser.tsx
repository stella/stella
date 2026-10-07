import { useState } from "react";

import { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import type { ContextMenuAction } from "@stll/ui/context-menu";
import {
  CheckIcon,
  ChevronDownIcon,
  FileDownIcon,
  GraduationCapIcon,
  LoaderIcon,
  PlusIcon,
} from "@stll/ui/icons";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { stellaToast } from "@stll/ui/toast";

import {
  CatalogueRow,
  type CatalogueRowDisplay,
} from "@/components/catalogue/catalogue-row";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import { McpIcon } from "@/components/mcp-icon";
import {
  memberKnowledgeActions,
  memberKnowledgeSource,
} from "@/features/knowledge/member/member-knowledge";
import {
  ToolsCatalogueView,
  type ToolsCatalogueKind,
} from "@/features/knowledge/views/tools/tools-catalogue-view";
import { useMountEffect } from "@/hooks/use-effect";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import type { PracticeJurisdiction } from "@/lib/jurisdictions";
import {
  isEffectivelyInstalled,
  type CatalogueDisplayEntry,
} from "@/lib/knowledge/catalogue-types";
import { useChatUnavailableSkills } from "@/lib/prompts/use-chat-unavailable-skills";
import {
  BlueprintGallerySheet,
  type BlueprintCreatedSkill,
} from "@/routes/knowledge/-components/blueprint-gallery-sheet";
import { ImportSkillDialog } from "@/routes/knowledge/-components/import-skill-dialog";

import { addCustomActions } from "./add-custom-actions.logic";
import { AddMcpServerSheet } from "./add-mcp-server-sheet";
import { InstallPackButton } from "./install-pack-button";
import { getToolDetailPayload, toolDetailTabId } from "./tool-detail";
import { useCatalogueRemoval } from "./use-catalogue-removal";
import { useInstallEntry } from "./use-install-entry";
import { useUninstallEntry } from "./use-uninstall-entry";

export type CatalogueBrowserFilterKind = ToolsCatalogueKind;

type CatalogueBrowserProps = {
  organizationId: string;
  /** Initial kind filter (e.g. from `?kind=mcp` on the unified surface). */
  initialKind?: CatalogueBrowserFilterKind | undefined;
  /** Catalogue slug whose detail panel opens on mount (`?slug=krs`), so a link
   *  from elsewhere in the product lands on the entry it names. */
  initialSlug?: string | undefined;
  /**
   * When true, render the "Add custom" dropdown in the toolbar. Disabled
   * for the onboarding flow.
   */
  showAddCustom?: boolean;
  /** Caller-resolved gate for creating and importing private skills. */
  canCreateSkills: boolean;
  /**
   * Caller-resolved permission gate for creating custom team tools. Members
   * can still create and import private skills. The route owns role loading
   * so this browser cannot trigger a cold non-suspense query during mount.
   */
  canManageCustomTools: boolean;
  /**
   * Seeds the jurisdiction filter so a CZ-based user lands on Tools and
   * sees only CZ + EU entries by default. Mirrors the onboarding step.
   * Universal entries (no jurisdictions) always pass.
   */
  practiceJurisdictions?: readonly PracticeJurisdiction[];
};

const toRowDisplay = (entry: CatalogueDisplayEntry): CatalogueRowDisplay => ({
  slug: entry.slug,
  kind: entry.kind,
  displayName: entry.displayName,
  description: entry.description,
  author: entry.author,
  cost: entry.cost,
  setup: entry.setup,
  icon: entry.icon,
  iconUrl: entry.iconUrl,
  jurisdictions: entry.jurisdictions,
});

/** The organization's tools: the shared catalogue view with the member's
 *  install state, detail inspector, and custom-tool tools in its slots. */
const CatalogueBrowser = ({
  organizationId,
  initialKind,
  initialSlug,
  showAddCustom = true,
  canCreateSkills,
  canManageCustomTools,
  practiceJurisdictions,
}: CatalogueBrowserProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const { data } = memberKnowledgeSource.useToolsCatalogue(organizationId);
  const toolsActions = memberKnowledgeActions.useToolsActions(organizationId);
  const inspector = useInspectorView();
  // Active tool-detail tab in the inspector → focused slug for the
  // row highlight. One source of truth; closing the inspector tab
  // clears the highlight automatically.
  const focusedTabId = useInspectorTabsStore((s) => {
    const active = s.tabs.find((tab) => tab.id === s.activeId);
    if (active?.type !== "view") {
      return null;
    }
    if (active.viewType !== "tool-detail") {
      return null;
    }
    return active.id;
  });
  const [addMcpOpen, setAddMcpOpen] = useState(false);
  const [blueprintGalleryOpen, setBlueprintGalleryOpen] = useState(false);
  const [importSkillOpen, setImportSkillOpen] = useState(false);

  const entries = data.entries;

  const onRowFocus = (entry: CatalogueDisplayEntry) => {
    const tabId = toolDetailTabId(entry.kind, entry.slug);
    if (focusedTabId === tabId) {
      inspector.close(tabId);
      return;
    }
    inspector.open({
      type: "tool-detail",
      id: tabId,
      label: entry.displayName,
      payload: getToolDetailPayload(entry, organizationId),
      ownerRouteId: "/knowledge/tools",
    });
  };

  // A deep link naming an entry opens its detail panel once the catalogue is
  // loaded (it already is: `catalogueOptions` is a suspense query). Mount-only,
  // so closing the panel does not fight the link on the next render.
  useMountEffect(() => {
    if (initialSlug === undefined) {
      return;
    }
    const linked = entries.find((entry) => entry.slug === initialSlug);
    if (linked) {
      onRowFocus(linked);
    }
  });

  const onSkillSheetChanged = toolsActions.invalidateSkillsAndCatalogue;

  // A blueprint instantiates a disabled draft; drop the user straight into the
  // full-screen editor route to customise and enable it.
  const onBlueprintCreated = (skill: BlueprintCreatedSkill) => {
    onSkillSheetChanged();
    detached(
      navigate({
        to: "/knowledge/tools/$entry",
        params: { entry: skill.id },
      }),
      "catalogue-browser.navigate",
    );
  };

  const openEditInstalledSkill = (entry: CatalogueDisplayEntry) => {
    if (entry.kind !== "skill" || entry.installedSkillId === null) {
      return;
    }
    detached(
      navigate({
        to: "/knowledge/tools/$entry",
        params: { entry: entry.installedSkillId },
      }),
      "catalogue-browser.navigate",
    );
  };

  const addActions = addCustomActions({
    canManageCustomTools,
    canCreateSkills,
  });
  const showAddCustomMenu = showAddCustom && addActions.length > 0;

  return (
    <ToolsCatalogueView
      addAction={
        showAddCustomMenu ? (
          <Menu>
            <MenuTrigger
              render={<Button className="h-11 sm:h-8" type="button" />}
            >
              <PlusIcon className="size-3.5" />
              {t("catalogue.addCustom")}
              <ChevronDownIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="w-56">
              {addActions.map((action) => {
                switch (action) {
                  case "mcp":
                    return (
                      <MenuItem
                        key={action}
                        onClick={() => setAddMcpOpen(true)}
                      >
                        <McpIcon className="size-4" />
                        {t("catalogue.addCustomMcp")}
                      </MenuItem>
                    );
                  case "skill-blueprint":
                    return (
                      <MenuItem
                        key={action}
                        onClick={() => setBlueprintGalleryOpen(true)}
                      >
                        <GraduationCapIcon className="size-4" />
                        {t("catalogue.addCustomSkill")}
                      </MenuItem>
                    );
                  case "skill-import":
                    return (
                      <MenuItem
                        key={action}
                        onClick={() => setImportSkillOpen(true)}
                      >
                        <FileDownIcon className="size-4" />
                        {t("knowledge.agentSkills.importSkill")}
                      </MenuItem>
                    );
                  default: {
                    action satisfies never;
                    return panic(`Unhandled add action: ${String(action)}`);
                  }
                }
              })}
            </MenuPopup>
          </Menu>
        ) : undefined
      }
      initialKind={initialKind}
      // Members can't create connectors, so the empty-connector call to
      // action is for admins and owners, like the add-custom menu.
      mcpEmptyAction={
        canManageCustomTools ? (
          <Button onClick={() => setAddMcpOpen(true)} type="button">
            <PlusIcon className="size-4" />
            {t("catalogue.addCustomMcp")}
          </Button>
        ) : undefined
      }
      practiceJurisdictions={practiceJurisdictions}
      recommendedAction={(inView) => {
        const installableInView = inView.filter(
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
      }}
      renderEntry={(entry) => (
        <CatalogueEntryRow
          entry={entry}
          focused={focusedTabId === toolDetailTabId(entry.kind, entry.slug)}
          key={`${entry.kind}-${entry.slug}`}
          onEditSkill={() => openEditInstalledSkill(entry)}
          onFocus={() => onRowFocus(entry)}
          organizationId={organizationId}
        />
      )}
      source={{ entries }}
    >
      <AddMcpServerSheet
        onOpenChange={setAddMcpOpen}
        open={addMcpOpen}
        organizationId={organizationId}
      />
      <BlueprintGallerySheet
        canManageTeam={canManageCustomTools}
        onCreated={onBlueprintCreated}
        onOpenChange={setBlueprintGalleryOpen}
        open={blueprintGalleryOpen}
      />
      {canCreateSkills && (
        <ImportSkillDialog
          canManageTeam={canManageCustomTools}
          onImported={onSkillSheetChanged}
          onOpenChange={setImportSkillOpen}
          open={importSkillOpen}
        />
      )}
    </ToolsCatalogueView>
  );
};

type CatalogueBrowserWithRouteDataProps = {
  canCreateSkills: boolean;
  canManageCustomTools: boolean;
  organizationId: string;
  initialKind?: CatalogueBrowserFilterKind | undefined;
  initialSlug?: string | undefined;
  practiceJurisdictions: readonly PracticeJurisdiction[];
};

export const CatalogueBrowserWithRouteData = ({
  canCreateSkills,
  canManageCustomTools,
  organizationId,
  initialKind,
  initialSlug,
  practiceJurisdictions,
}: CatalogueBrowserWithRouteDataProps) => (
  <CatalogueBrowser
    canCreateSkills={canCreateSkills}
    canManageCustomTools={canManageCustomTools}
    initialKind={initialKind}
    initialSlug={initialSlug}
    organizationId={organizationId}
    practiceJurisdictions={practiceJurisdictions}
  />
);

type CatalogueEntryRowProps = {
  entry: CatalogueDisplayEntry;
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
  const { id: userId } = useAuthenticatedUser();
  const chatUnavailableSkills = useChatUnavailableSkills(
    organizationId,
    userId,
  );
  const chatMissingTools =
    entry.kind === "skill" && entry.chatSkillId !== null
      ? chatUnavailableSkills?.get(entry.chatSkillId)
      : undefined;
  const uninstall = useUninstallEntry(entry, organizationId);
  const { removal, requestRemoval, confirmDialog } = useCatalogueRemoval({
    entry,
    onRemove: () => uninstall.mutate(),
  });

  const effectivelyInstalled = isEffectivelyInstalled(entry);
  const installable =
    !effectivelyInstalled && entry.installState !== "unavailable";

  const onInstall = () => {
    install.mutate(entry, {
      onSuccess: () => {
        stellaToast.add({
          title: t("catalogue.installed", { name: entry.displayName }),
          type: "success",
        });
      },
      onError: (error) => {
        notifyUserError(error, t("catalogue.installFailed"));
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
  } else if (removal !== "none") {
    actions = (
      <Button
        disabled={uninstall.isPending}
        onClick={(e) => {
          e.stopPropagation();
          requestRemoval();
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
        role="img"
      >
        <CheckIcon aria-hidden className="size-3.5" />
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
    <>
      <CatalogueRow
        actions={actions}
        contextActions={contextActions}
        display={toRowDisplay(entry)}
        focused={focused}
        notice={
          chatMissingTools === undefined
            ? undefined
            : t("catalogue.skillNeedsUnavailableTools", {
                tools: chatMissingTools.join(", "),
              })
        }
        onFocus={onFocus}
      />
      {confirmDialog}
    </>
  );
};
