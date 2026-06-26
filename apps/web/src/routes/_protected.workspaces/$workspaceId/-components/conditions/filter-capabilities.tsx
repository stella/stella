import type { ConditionCapabilities } from "@/components/conditions/condition-builder";
import {
  isMultiValue,
  leafValueList,
  leafValueString,
} from "@/components/conditions/condition-builder-logic";
import type { FieldOption } from "@/components/conditions/condition-builder-logic";
import {
  type FacetContext,
  MultiSelectValue,
  SingleSelectValue,
} from "@/routes/_protected.workspaces/$workspaceId/-components/conditions/condition-select-values";

type FilterCapabilitiesArgs = {
  fields: FieldOption[];
  facetContext?: FacetContext | undefined;
  /** Whether the surface offers nested groups (the advanced-filter popover does;
   *  a single-property dependency gate does not). */
  allowNesting?: boolean;
};

/**
 * The View filter profile for the shared `ConditionBuilder`: the full default
 * operator/label/value-editor behavior (no overrides), plus facet-aware select
 * editors injected through `renderValueEditor`. Filters never use formulas.
 */
export const filterCapabilities = ({
  fields,
  facetContext,
  allowNesting = false,
}: FilterCapabilitiesArgs): ConditionCapabilities => ({
  fields,
  allowNesting,
  renderValueEditor: ({ editorKind, field, node, operator, emit }) => {
    // Only the select editor is facet-aware; every other kind falls through to
    // the shared built-ins (text / int / date / none) by returning null.
    if (editorKind !== "select") {
      return null;
    }
    if (isMultiValue(operator)) {
      return (
        <MultiSelectValue
          facetContext={facetContext}
          field={field}
          onChange={emit}
          value={leafValueList(node)}
        />
      );
    }
    return (
      <SingleSelectValue
        facetContext={facetContext}
        field={field}
        onChange={emit}
        value={leafValueString(node)}
      />
    );
  },
});
