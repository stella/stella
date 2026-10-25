import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import {
  List,
  ListEmpty,
  ListItem,
  ListItemActions,
  ListItemContent,
  ListItemDescription,
  ListItemMedia,
  ListItemTitle,
} from "@stll/ui/list";
import { SearchField } from "@stll/ui/search-field";
import { Switch } from "@stll/ui/switch";

import { CatalogueEntryIcon } from "@/components/catalogue/catalogue-entry-icon";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { usePermissions } from "@/hooks/use-permissions";
import { matchesConnectionQuery } from "@/lib/account/connections.logic";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import type { McpConnectorsResponse } from "@/lib/knowledge/queries";
import { useQueryView } from "@/lib/use-query-view";
import { resourceMutation } from "@/lib/workspace-realtime";

export const NativeToolsList = () => {
  const t = useTranslations();
  const [search, setSearch] = useState("");
  const { activeOrganizationId } = useAuthenticatedUser();
  const view = useQueryView(
    useQuery(mcpConnectorsOptions(activeOrganizationId)),
  );
  const canEdit = usePermissions({ organizationSettings: ["update"] });
  const visible =
    view.type === "items"
      ? view.items.nativeTools.filter((tool) =>
          matchesConnectionQuery(search, [
            tool.displayName,
            tool.description,
            tool.slug,
          ]),
        )
      : [];

  return (
    <>
      <SearchField
        aria-label={t("common.search")}
        clearLabel={t("common.clearSearch")}
        onValueChange={setSearch}
        value={search}
      />
      <QueryViewFeedback view={view} />
      {view.type === "items" && (
        <List>
          {visible.map((tool) => (
            <NativeToolRow key={tool.slug} tool={tool} canEdit={canEdit} />
          ))}
          {visible.length === 0 && (
            <ListEmpty>{t("common.noResults")}</ListEmpty>
          )}
        </List>
      )}
    </>
  );
};

const NativeToolRow = ({
  tool,
  canEdit,
}: {
  tool: McpConnectorsResponse["nativeTools"][number];
  canEdit: boolean;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: resourceMutation({
      mutation: "updateNativeTool",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async (enabled: boolean) =>
        unwrapEden(
          await api.mcp["native-tools"]({ slug: tool.slug }).patch({ enabled }),
        ),
    }),
    onError: (error) => notifyUserError(error, t("errors.actionFailed")),
  });

  return (
    <ListItem>
      <ListItemMedia>
        <CatalogueEntryIcon slug={tool.slug} iconUrl={tool.iconUrl} size={18} />
      </ListItemMedia>
      <ListItemContent>
        <ListItemTitle>
          <BidiText>{tool.displayName}</BidiText>
        </ListItemTitle>
        <ListItemDescription>{tool.description}</ListItemDescription>
      </ListItemContent>
      <ListItemActions>
        <Switch
          aria-label={tool.displayName}
          checked={tool.enabled}
          disabled={!canEdit || mutation.isPending}
          onCheckedChange={(enabled) => mutation.mutate(enabled)}
        />
      </ListItemActions>
    </ListItem>
  );
};
