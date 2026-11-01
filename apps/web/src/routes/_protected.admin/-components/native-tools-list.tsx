import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
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
import {
  nativeToolDescriptionKey,
  nativeToolLabelKey,
} from "@/components/catalogue/native-tool-label";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { usePermissions } from "@/hooks/use-permissions";
import { matchesConnectionQuery } from "@/lib/account/connections.logic";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapApiResponse } from "@/lib/errors/api";
import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import type { McpConnectorsResponse } from "@/lib/knowledge/queries";
import { queryView } from "@/lib/query-view.logic";
import { useSettingsMutation } from "@/routes/_protected.admin/-hooks/use-settings-mutation";

type NativeTool = McpConnectorsResponse["nativeTools"][number];

/** A tool's name and description in the reader's language. */
const useNativeToolCopy = () => {
  const t = useTranslations();
  return (tool: NativeTool) => {
    const entry = { slug: tool.slug, kind: "native-tool" };
    const labelKey = nativeToolLabelKey(entry);
    const descriptionKey = nativeToolDescriptionKey(entry);
    return {
      displayName: labelKey ? t(labelKey) : tool.displayName,
      description: descriptionKey ? t(descriptionKey) : tool.description,
    };
  };
};

export const NativeToolsList = () => {
  const t = useTranslations();
  const nativeToolCopy = useNativeToolCopy();
  const [search, setSearch] = useState("");
  const { activeOrganizationId } = useAuthenticatedUser();
  const view = queryView(useQuery(mcpConnectorsOptions(activeOrganizationId)));
  const canEdit = usePermissions({ organizationSettings: ["update"] });
  const visible =
    view.type === "items"
      ? view.items.nativeTools.filter((tool) => {
          const { description, displayName } = nativeToolCopy(tool);
          return matchesConnectionQuery(search, [
            displayName,
            description,
            tool.displayName,
            tool.slug,
          ]);
        })
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
  tool: NativeTool;
  canEdit: boolean;
}) => {
  const t = useTranslations();
  const { description, displayName } = useNativeToolCopy()(tool);
  const { activeOrganizationId } = useAuthenticatedUser();
  const mutation = useSettingsMutation({
    exceptionScope: {
      type: "handler",
      handlerId: "NativeToolRow.update:failure",
    },
    mutationFn: async (enabled: boolean) =>
      unwrapApiResponse(
        await api.mcp["native-tools"]({ slug: tool.slug }).patch({ enabled }),
      ),
    invalidate: mcpConnectorsOptions(activeOrganizationId).queryKey,
    errorToast: { title: t("errors.actionFailed") },
  });

  return (
    <ListItem>
      <ListItemMedia>
        <CatalogueEntryIcon slug={tool.slug} iconUrl={tool.iconUrl} size={18} />
      </ListItemMedia>
      <ListItemContent>
        <ListItemTitle>
          <BidiText>{displayName}</BidiText>
        </ListItemTitle>
        <ListItemDescription>{description}</ListItemDescription>
      </ListItemContent>
      <ListItemActions>
        <Switch
          aria-label={displayName}
          checked={tool.enabled}
          disabled={!canEdit || mutation.isPending}
          onCheckedChange={(enabled) => mutation.mutate(enabled)}
        />
      </ListItemActions>
    </ListItem>
  );
};
