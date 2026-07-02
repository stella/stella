import { toSafeId } from "@/lib/safe-id";
import type { PropertyDependency, WorkspaceProperty } from "@/lib/types";
import type { TableColumnDef } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";

// The workspace "Document Type" classifier: a single-select column computed by an
// AI model whose name (trimmed, lower-cased) is "document type". Mirrors the
// server-side `resolveDocTypeClassifier` so the grouped table keys per-section
// columns off the very column a playbook run gates against.
const DOCUMENT_TYPE_CLASSIFIER_NAME = "document type";

export const isDocumentTypeClassifier = (
  property: WorkspaceProperty,
): boolean =>
  property.content.type === "single-select" &&
  property.tool.type === "ai-model" &&
  property.name.trim().toLowerCase() === DOCUMENT_TYPE_CLASSIFIER_NAME;

// A playbook column scoped to a document type carries a dependency on the
// classifier whose condition is `classifier == <document-type label>` — the exact
// gate `materializePlaybookRun` writes. Reading that label back lets the grouped
// table place the column in its matching section without a separate playbooks
// fetch (neither the list nor detail endpoint exposes the playbook scope).
export const docTypeGateLabel = (
  dependency: PropertyDependency,
  classifierPropertyId: string,
): string | null => {
  if (dependency.dependsOnPropertyId !== classifierPropertyId) {
    return null;
  }
  const { condition } = dependency;
  if (
    condition === null ||
    condition.type !== "compare" ||
    condition.op !== "eq"
  ) {
    return null;
  }
  const { left, right } = condition;
  if (
    left.type === "property" &&
    left.propertyId === classifierPropertyId &&
    right.type === "literal" &&
    typeof right.value === "string"
  ) {
    return right.value;
  }
  return null;
};

// Build the dependency gate that scopes an AI column to one document type: a
// dependency on the classifier whose condition is `classifier == <label>`. The
// exact shape {@link docTypeGateLabel} reads back and `materializePlaybookRun`
// writes, so a manually-scoped column lands in its section like a playbook one.
export const buildDocTypeGate = (
  classifierPropertyId: string,
  label: string,
): PropertyDependency => ({
  dependsOnPropertyId: toSafeId<"property">(classifierPropertyId),
  condition: {
    type: "compare",
    left: { type: "property", propertyId: classifierPropertyId },
    op: "eq",
    right: { type: "literal", value: label },
  },
});

// propertyId -> the document-type labels its column is gated to. A property absent
// from the map is ungated (no document-type scope) and shows in every section. A
// property gated to several labels (multiple gates) shows in each matching one.
export const buildDocTypeGateLabels = ({
  properties,
  classifierPropertyId,
}: {
  properties: WorkspaceProperty[];
  classifierPropertyId: string;
}): Map<string, Set<string>> => {
  const gateLabelsByPropertyId = new Map<string, Set<string>>();
  for (const property of properties) {
    if (
      property.tool.type !== "ai-model" &&
      property.tool.type !== "manual-input"
    ) {
      continue;
    }
    const dependencies = property.tool.dependencies ?? [];
    const labels = new Set<string>();
    for (const dependency of dependencies) {
      const label = docTypeGateLabel(dependency, classifierPropertyId);
      if (label !== null) {
        labels.add(label);
      }
    }
    if (labels.size > 0) {
      gateLabelsByPropertyId.set(property.id, labels);
    }
  }
  return gateLabelsByPropertyId;
};

// The column subset for one group section: every ungated column plus the
// document-type-gated columns whose gate matches this section's label. The
// uncategorized section (null value) carries only the ungated columns. Returns
// the input array unchanged when nothing is gated (non-document-type groupings),
// preserving referential stability for the table instance.
export const selectGroupColumns = ({
  columns,
  gateLabelsByColumnId,
  groupValue,
}: {
  columns: TableColumnDef[];
  gateLabelsByColumnId: Map<string, Set<string>>;
  groupValue: string | null;
}): TableColumnDef[] => {
  if (gateLabelsByColumnId.size === 0) {
    return columns;
  }
  return columns.filter((column) => {
    const labels =
      column.id === undefined ? undefined : gateLabelsByColumnId.get(column.id);
    if (labels === undefined) {
      return true;
    }
    return groupValue !== null && labels.has(groupValue);
  });
};
