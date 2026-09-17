import { useTranslations } from "use-intl";

import type { GroupNode } from "@stll/conditions";
import { Button } from "@stll/ui/button";

import { ConditionBuilder } from "@/components/conditions/condition-builder";
import type { FieldOption } from "@/components/conditions/condition-builder-logic";
import type { FacetContext } from "@/components/workspaces/conditions/condition-select-values";
import { filterCapabilities } from "@/components/workspaces/conditions/filter-capabilities";

type AdvancedFilterEditorProps = {
  node: GroupNode;
  fields: FieldOption[];
  facetContext?: FacetContext | undefined;
  onChange: (next: GroupNode) => void;
  onRemove: () => void;
};

export const AdvancedFilterEditor = ({
  node,
  fields,
  facetContext,
  onChange,
  onRemove,
}: AdvancedFilterEditorProps) => {
  const t = useTranslations();

  return (
    <div className="flex max-h-[min(48rem,80dvh,var(--available-height,80dvh))] min-h-0 flex-col overflow-hidden">
      <div
        className="min-h-0 overflow-auto overscroll-contain p-3"
        data-slot="advanced-filter-scroll-region"
      >
        <ConditionBuilder
          capabilities={filterCapabilities({
            fields,
            facetContext,
            allowNesting: true,
          })}
          onChange={onChange}
          value={node}
        />
      </div>
      <div className="shrink-0 border-t p-2" data-slot="advanced-filter-footer">
        <Button onClick={onRemove} size="xs" variant="muted">
          {t("workspaces.views.removeAdvancedFilter")}
        </Button>
      </div>
    </div>
  );
};

export const ADVANCED_FILTER_POPUP_CLASS_NAME = "w-[44rem] max-w-[92vw]";
