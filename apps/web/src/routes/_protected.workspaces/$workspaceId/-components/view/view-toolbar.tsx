import { useSuspenseQuery } from "@tanstack/react-query";
import {
  ClockIcon,
  EyeIcon,
  HashIcon,
  SparklesIcon,
  UserIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stella/ui/components/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";

import type { ViewLayout, WorkspaceProperty, WorkspaceView } from "@/lib/types";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";
import { FilterChips } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar-filters";
import { SortChips } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar-sorts";
import { useUpdateView } from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import {
  getInternalPropertyId,
  resolveKanbanGroupBy,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

type ViewToolbarProps = {
  view: WorkspaceView;
  workspaceId: string;
};

export const ViewToolbar = ({ view, workspaceId }: ViewToolbarProps) => {
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const updateView = useUpdateView(workspaceId);
  const { filters, sorts, hiddenProperties } = view.layout;

  const handleUpdate = (changes: Partial<ViewLayout>) => {
    updateView.mutate({
      viewId: view.id,
      layout: { ...view.layout, ...changes } as ViewLayout,
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-1 px-2 py-1">
      <FilterChips
        filters={filters}
        onUpdate={(filters) => handleUpdate({ filters })}
        properties={properties}
      />

      <SortChips
        onUpdate={(sorts) => handleUpdate({ sorts })}
        properties={properties}
        sorts={sorts}
      />

      <PropertiesToggle
        hiddenProperties={hiddenProperties}
        onChange={(next) => handleUpdate({ hiddenProperties: next })}
        properties={properties}
      />

      {view.layout.type === "kanban" && (
        <>
          <span className="mx-1 h-4 w-px bg-border" />
          <KanbanGroupByControl
            groupByPropertyId={view.layout.groupByPropertyId}
            onChange={(groupByPropertyId) =>
              handleUpdate({ groupByPropertyId })
            }
            properties={properties}
          />
        </>
      )}
    </div>
  );
};

// -- Layout-specific controls --

type KanbanGroupByControlProps = {
  properties: WorkspaceProperty[];
  groupByPropertyId: string | undefined;
  onChange: (propertyId: string) => void;
};

const KanbanGroupByControl = ({
  properties,
  groupByPropertyId,
  onChange,
}: KanbanGroupByControlProps) => {
  const t = useTranslations();
  const eligible = properties.filter((p) => p.content.type === "single-select");

  const resolvedId = resolveKanbanGroupBy(groupByPropertyId ?? "", properties);

  const resolvedLabel = (() => {
    if (resolvedId === getInternalPropertyId("kind")) {
      return t("common.kind");
    }
    if (resolvedId === getInternalPropertyId("created-by")) {
      return t("workspaces.filesystem.author");
    }
    return (
      eligible.find((p) => p.id === resolvedId)?.name ??
      t("workspaces.views.selectProperty")
    );
  })();

  return (
    <span className="flex items-center gap-1 text-xs">
      <span className="text-muted-foreground">
        {t("workspaces.views.groupBy")}
      </span>
      <Select
        onValueChange={(v) => {
          if (v !== null) {
            onChange(v);
          }
        }}
        value={resolvedId}
      >
        <SelectTrigger className="h-6 min-h-0 min-w-24 text-xs" size="sm">
          <SelectValue placeholder={resolvedLabel}>{resolvedLabel}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={getInternalPropertyId("kind")}>
            {t("common.kind")}
          </SelectItem>
          <SelectItem value={getInternalPropertyId("created-by")}>
            {t("workspaces.filesystem.author")}
          </SelectItem>
          {eligible.map((prop) => (
            <SelectItem key={prop.id} value={prop.id}>
              {prop.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </span>
  );
};

type PropertiesToggleProps = {
  properties: WorkspaceProperty[];
  hiddenProperties: string[];
  onChange: (hiddenProperties: string[]) => void;
};

const metadataFields = [
  { id: getInternalPropertyId("created-by"), name: "Author", icon: UserIcon },
  {
    id: getInternalPropertyId("updated-at"),
    name: "Last updated",
    icon: ClockIcon,
  },
  // TODO: waiting for Damian — version is hardcoded to 1
  { id: getInternalPropertyId("version"), name: "Version", icon: HashIcon },
] as const;

const PropertiesToggle = ({
  properties,
  hiddenProperties,
  onChange,
}: PropertiesToggleProps) => {
  const t = useTranslations();
  const toggleProperty = (propertyId: string) => {
    if (hiddenProperties.includes(propertyId)) {
      const next = hiddenProperties.filter((id) => id !== propertyId);
      onChange(next);
    } else {
      onChange([...hiddenProperties, propertyId]);
    }
  };

  const manualProperties = properties.filter(
    (p) => p.tool.type === "manual-input",
  );
  const aiProperties = properties.filter((p) => p.tool.type === "ai-model");

  return (
    <Menu>
      <MenuTrigger render={<Button size="icon-xs" variant="ghost" />}>
        <EyeIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup>
        <MenuGroup>
          <MenuGroupLabel>{t("common.metadata")}</MenuGroupLabel>
          {metadataFields.map((meta) => {
            const isVisible = !hiddenProperties.includes(meta.id);
            return (
              <MenuItem key={meta.id} onClick={() => toggleProperty(meta.id)}>
                <meta.icon className="size-4" />
                <span className="flex-1">{meta.name}</span>
                {isVisible && <span className="text-primary">{"\u2713"}</span>}
              </MenuItem>
            );
          })}
        </MenuGroup>
        {manualProperties.length > 0 && (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>{t("common.properties")}</MenuGroupLabel>
              {manualProperties.map((prop) => {
                const isVisible = !hiddenProperties.includes(prop.id);
                return (
                  <MenuItem
                    key={prop.id}
                    onClick={() => toggleProperty(prop.id)}
                  >
                    <PropertyIcon type={prop.content.type} />
                    <span className="flex-1">{prop.name}</span>
                    {isVisible && (
                      <span className="text-primary">{"\u2713"}</span>
                    )}
                  </MenuItem>
                );
              })}
            </MenuGroup>
          </>
        )}
        {aiProperties.length > 0 && (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>
                <SparklesIcon className="me-1 inline size-3" />
                {t("workspaces.views.aiGenerated")}
              </MenuGroupLabel>
              {aiProperties.map((prop) => {
                const isVisible = !hiddenProperties.includes(prop.id);
                return (
                  <MenuItem
                    key={prop.id}
                    onClick={() => toggleProperty(prop.id)}
                  >
                    <PropertyIcon type={prop.content.type} />
                    <span className="flex-1">{prop.name}</span>
                    {isVisible && (
                      <span className="text-primary">{"\u2713"}</span>
                    )}
                  </MenuItem>
                );
              })}
            </MenuGroup>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
};
