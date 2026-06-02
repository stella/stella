import { useState } from "react";

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import { SIDE_RAIL_TAB_ICON_SIZE_PX, TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { EditSkillSheet } from "@/routes/_protected.knowledge/-components/edit-skill-sheet";
import { knowledgeKeys } from "@/routes/_protected.knowledge/-queries";
import {
  catalogueKeys,
  catalogueOptions,
} from "@/routes/_protected.knowledge/-queries/catalogue";

import { CatalogueDetailPanel } from "./catalogue-detail-panel";
import { CatalogueEntryIcon } from "./catalogue-entry-icon";
import type { CatalogueEntry } from "./catalogue-types";
import { useInstallEntry } from "./use-install-entry";
import { useUninstallEntry } from "./use-uninstall-entry";

/**
 * Payload for the `tool-detail` inspector view. Strictly
 * structured-cloneable: just the slug + org id. The view re-reads
 * the live entry from the catalogue query data inside its render
 * so install/remove/toggle state updates flow through automatically
 * after their mutations invalidate the query — the tab payload
 * doesn't go stale.
 *
 * Cached entry data for the rail icon (so the icon survives even
 * if the entry temporarily disappears between refetches) lives in
 * a separate `iconHint` field — read-only, never the source of
 * truth for the rendered detail body.
 */
/**
 * Catalogue entries are unique by (kind, slug), not slug alone — a
 * custom MCP can claim a slug that also exists as a built-in skill
 * or native tool (e.g. `web-search`). Carry the kind so the panel
 * resolves to the right row instead of the first slug match.
 */
type ToolDetailKind = "skill" | "mcp" | "native-tool";

export type ToolDetailPayload = {
  kind: ToolDetailKind;
  slug: string;
  organizationId: string;
  /**
   * Frozen icon hint captured when the tab was opened. The
   * rail icon falls back to this if the entry is briefly absent
   * from the live query. Strictly the icon strings — no
   * behaviour, no derived state.
   */
  iconHint: {
    icon: string | null;
    iconUrl: string | null;
  };
};

type EditableSkillRef = {
  id: string;
  name: string;
  scope: "team" | "private";
  enabled: boolean;
};

export const ToolDetailView = ({
  tab,
  onClose,
}: InspectorViewRenderProps<ToolDetailPayload>) => {
  const { kind, slug, organizationId } = tab.payload;
  const { data } = useSuspenseQuery(catalogueOptions(organizationId));
  const entry = data.entries.find(
    (candidate: CatalogueEntry) =>
      candidate.kind === kind && candidate.slug === slug,
  );

  // Entry no longer in the catalogue — usually because the user
  // just removed a custom MCP. Render a deliberate empty state
  // instead of imperatively closing the tab; the user dismisses
  // it via the X. Keeps the data-to-UI mapping pure (no effect,
  // no render-phase side effect).
  if (entry === undefined) {
    return <RemovedToolPlaceholder onClose={onClose} />;
  }

  return (
    <ToolDetailContent
      entry={entry}
      onClose={onClose}
      organizationId={organizationId}
    />
  );
};

const RemovedToolPlaceholder = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslations();
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header
        className={cn(
          "border-border flex shrink-0 items-center justify-end border-b px-3",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <Button
          aria-label={t("common.close")}
          onClick={onClose}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <XIcon className="size-3.5" />
        </Button>
      </header>
      <div className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-sm">
        <p>{t("catalogue.removed")}</p>
      </div>
    </div>
  );
};

type ToolDetailContentProps = {
  entry: CatalogueEntry;
  onClose: () => void;
  organizationId: string;
};

const ToolDetailContent = ({
  entry,
  onClose,
  organizationId,
}: ToolDetailContentProps) => {
  const t = useTranslations();
  const install = useInstallEntry(organizationId);
  const uninstall = useUninstallEntry(entry, organizationId);
  const queryClient = useQueryClient();

  const [editSkill, setEditSkill] = useState<EditableSkillRef | null>(null);

  const onEditSkill = () => {
    if (entry.kind !== "skill" || entry.installedSkillId === null) {
      return;
    }
    setEditSkill({
      id: entry.installedSkillId,
      name: entry.displayName,
      scope: "team",
      enabled: entry.enabled ?? true,
    });
  };

  const onSkillSheetChanged = () => {
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.skills.all(organizationId),
    });
    void queryClient.invalidateQueries({
      queryKey: catalogueKeys.list(organizationId),
    });
  };

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

  return (
    <>
      <CatalogueDetailPanel
        entry={entry}
        installing={install.isPending}
        onClose={onClose}
        onEditSkill={onEditSkill}
        onInstall={onInstall}
        onRemove={() => uninstall.mutate()}
        removing={uninstall.isPending}
      />
      <EditSkillSheet
        onChanged={onSkillSheetChanged}
        onOpenChange={(open) => {
          if (!open) {
            setEditSkill(null);
          }
        }}
        open={editSkill !== null && editSkill.id !== ""}
        skill={editSkill !== null && editSkill.id !== "" ? editSkill : null}
      />
    </>
  );
};

export const ToolDetailRailIcon = ({
  tab,
}: InspectorRailIconProps<ToolDetailPayload>) => (
  <CatalogueEntryIcon
    icon={tab.payload.iconHint.icon}
    iconUrl={tab.payload.iconHint.iconUrl}
    size={SIDE_RAIL_TAB_ICON_SIZE_PX}
    slug={tab.payload.slug}
  />
);

/**
 * Build the inspector tab id for a given catalogue entry. The kind
 * is part of the id because (kind, slug) is the catalogue's actual
 * uniqueness key; using slug alone would collapse an MCP and a skill
 * sharing the same slug onto the same tab.
 */
export const toolDetailTabId = (kind: ToolDetailKind, slug: string): string =>
  `tool-detail:${kind}:${slug}`;
