import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@stll/ui/command";
import { CheckIcon, ChevronDownIcon } from "@stll/ui/icons";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import {
  Tooltip as TooltipRoot,
  TooltipPopup,
  TooltipTrigger,
} from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import {
  filterMattersByQuery,
  selectSiblingMatters,
} from "@/components/breadcrumbs/matter-switcher.logic";
import { CRUMB_SWITCHER_REVEAL_CLASS_NAME } from "@/components/breadcrumbs/shared";
import { MatterOptionLabel } from "@/components/matter-option-label";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { useMatterNumberingEnabled } from "@/lib/organization/use-matter-numbering";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import { workspacesRouteOptions } from "@/lib/workspaces/queries";
import { useConfigStore } from "@/stores/config-store";

type MatterSwitcherProps = {
  matter: {
    client: { displayName: string; id: string } | null;
    id: string;
  };
  /** More crumbs follow, so the caret waits for a hover over its crumb. */
  revealOnHover?: boolean;
};

/**
 * The breadcrumb's caret beside the matter name: a searchable list of the
 * matters that share its client (or the other personal matters), current one
 * checked, so people move between a client's matters without going back to
 * the matter list. The list loads only once the popover opens.
 */
export const MatterSwitcher = ({
  matter,
  revealOnHover = false,
}: MatterSwitcherProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const { activeOrganizationId } = useAuthenticatedUser();
  const showMatterNumber = useMatterNumberingEnabled();
  const updateMattersConfig = useConfigStore((s) => s.updateMatters);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const mattersQuery = useQuery({
    ...workspacesRouteOptions(activeOrganizationId),
    enabled: open,
  });
  const mattersView = queryView(mattersQuery);
  useQueryViewError(mattersView, "MatterSwitcher:query");

  const { client } = matter;
  const siblings =
    mattersView.type === "items"
      ? selectSiblingMatters({
          clientId: client?.id ?? null,
          matters: mattersView.items.workspaces,
        }).map((sibling) => ({
          color: sibling.color,
          id: sibling.id,
          name: sibling.name,
          reference:
            showMatterNumber && sibling.reference !== ""
              ? sibling.reference
              : null,
        }))
      : [];
  const visible = filterMattersByQuery(siblings, query);
  const label = t("workspaces.switcher.trigger");

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
    }
  };

  const openMatter = (workspaceId: string) => {
    changeOpen(false);
    if (workspaceId === matter.id) {
      return;
    }
    detached(
      navigate({ to: "/workspaces/$workspaceId", params: { workspaceId } }),
      "matter-switcher.navigate",
    );
  };

  const openMatterList = () => {
    changeOpen(false);
    if (client === null) {
      updateMattersConfig({ clientFilter: null });
      detached(navigate({ to: "/workspaces" }), "matter-switcher.list");
      return;
    }
    // Same landing as the client breadcrumb: the full list grouped by client,
    // scrolled to this client's group.
    updateMattersConfig({ groupBy: "client", filters: {} });
    detached(
      navigate({ to: "/workspaces", search: { focusClient: client.id } }),
      "matter-switcher.list",
    );
  };

  return (
    <Popover onOpenChange={changeOpen} open={open}>
      <TooltipRoot>
        <PopoverTrigger
          render={
            <TooltipTrigger
              render={
                <Button
                  aria-label={label}
                  className={cn(
                    revealOnHover && CRUMB_SWITCHER_REVEAL_CLASS_NAME,
                  )}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            />
          }
        >
          <ChevronDownIcon />
        </PopoverTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </TooltipRoot>
      <PopoverPopup align="start" className="w-72" padding="none">
        <Command mode="none" onValueChange={setQuery} value={query}>
          <div className="border-b px-2.5 py-2">
            <CommandInput
              aria-label={label}
              autoFocus
              placeholder={t("workspaces.switcher.searchPlaceholder")}
              size="sm"
            />
          </div>
          <CommandList>
            <div className="p-1">
              {mattersView.type !== "items" ||
              mattersView.refetchError !== undefined ? (
                <div className="px-2 py-1.5">
                  <QueryViewFeedback view={mattersView} />
                </div>
              ) : null}
              {mattersView.type === "items" && visible.length === 0 ? (
                <p className="text-muted-foreground px-2 py-1.5 text-sm">
                  {t("common.noResults")}
                </p>
              ) : null}
              {visible.map((sibling) => {
                const isCurrent = sibling.id === matter.id;
                return (
                  <CommandItem
                    aria-current={isCurrent ? "page" : undefined}
                    key={sibling.id}
                    onClick={() => openMatter(sibling.id)}
                    value={sibling.id}
                  >
                    <MatterOptionLabel matter={sibling} />
                    {sibling.reference === null ? null : (
                      <bdi className="text-muted-foreground shrink-0 text-xs">
                        {sibling.reference}
                      </bdi>
                    )}
                    {isCurrent ? <CheckIcon className="ms-auto" /> : null}
                  </CommandItem>
                );
              })}
              <CommandSeparator className="my-1" />
              <CommandItem onClick={openMatterList} value="__all-matters__">
                <span className="min-w-0 truncate">
                  {client === null
                    ? t("workspaces.switcher.viewAll")
                    : t("workspaces.switcher.viewAllForClient", {
                        clientName: client.displayName,
                      })}
                </span>
              </CommandItem>
            </div>
          </CommandList>
        </Command>
      </PopoverPopup>
    </Popover>
  );
};
