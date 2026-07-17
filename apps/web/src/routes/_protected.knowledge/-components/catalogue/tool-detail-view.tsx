import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { CatalogueEntryIcon } from "@/components/catalogue/catalogue-entry-icon";
import { catalogueOptions } from "@/components/catalogue/catalogue-queries";
import type { ActiveSkillChatContext } from "@/components/inspector/inspector-active-skill";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import { SIDE_RAIL_TAB_ICON_SIZE_PX, TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

import { CatalogueDetailPanel } from "./catalogue-detail-panel";
import type { CatalogueEntry } from "./catalogue-types";
import { useInstallEntry } from "./use-install-entry";
import { useUninstallEntry } from "./use-uninstall-entry";

/**
 * Payload for the `tool-detail` inspector view. Strictly
 * structured-cloneable: just catalogue identity, icon hints, and
 * optional skill chat context. The view re-reads the live entry
 * from the catalogue query data inside its render so install/remove/
 * toggle state updates flow through automatically after mutations
 * invalidate the query — the tab payload doesn't go stale.
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
export type ToolDetailKind = "skill" | "mcp" | "native-tool";

export type ToolDetailPayload = {
  kind: ToolDetailKind;
  slug: string;
  organizationId: string;
  /**
   * Context used when a chat is opened from this detail tab. Present
   * only for installed skill entries; MCP/native-tool details are
   * not skill editing surfaces.
   */
  activeSkill?: ActiveSkillChatContext | undefined;
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
  const navigate = useNavigate();
  const install = useInstallEntry(organizationId);
  const uninstall = useUninstallEntry(entry, organizationId);

  const onEditSkill = () => {
    if (entry.kind !== "skill" || entry.installedSkillId === null) {
      return;
    }
    void navigate({
      to: "/knowledge/tools/$skillId",
      params: { skillId: entry.installedSkillId },
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
          title: userErrorFromThrown(error, t("catalogue.installFailed")),
          type: "error",
        });
      },
    });
  };

  return (
    <CatalogueDetailPanel
      entry={entry}
      installing={install.isPending}
      onClose={onClose}
      onEditSkill={onEditSkill}
      onInstall={onInstall}
      onRemove={() => uninstall.mutate()}
      removing={uninstall.isPending}
    />
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
