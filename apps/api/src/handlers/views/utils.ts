import type {
  ViewLayout,
  ViewLayoutBase,
  ViewLayoutType,
} from "@/api/lib/views-schema";

export const cleanStalePropertyIds = (
  layout: ViewLayout,
  propertyIds: string[],
): boolean => {
  let changed = false;

  const isInternal = (id: string) => id.startsWith("_");

  const cleanedHidden = layout.hiddenProperties.filter(
    (id) => propertyIds.includes(id) || isInternal(id),
  );
  if (cleanedHidden.length !== layout.hiddenProperties.length) {
    layout.hiddenProperties = cleanedHidden;
    changed = true;
  }

  const cleanedSorts = layout.sorts.filter(
    (s) => propertyIds.includes(s.propertyId) || isInternal(s.propertyId),
  );
  if (cleanedSorts.length !== layout.sorts.length) {
    layout.sorts = cleanedSorts;
    changed = true;
  }

  const cleanedFilters = layout.filters.filter(
    (f) =>
      f.field === "kind" ||
      f.field === "builtin" ||
      (f.field === "property" && propertyIds.includes(f.propertyId)),
  );
  if (cleanedFilters.length !== layout.filters.length) {
    layout.filters = cleanedFilters;
    changed = true;
  }

  if (layout.type === "table") {
    const cleanedOrder = layout.columnOrder.filter(
      (id) => propertyIds.includes(id) || isInternal(id),
    );
    if (cleanedOrder.length !== layout.columnOrder.length) {
      layout.columnOrder = cleanedOrder;
      changed = true;
    }

    const cleanedPinning = layout.columnPinning.filter(
      (id) => propertyIds.includes(id) || isInternal(id),
    );

    if (cleanedPinning.length !== layout.columnPinning.length) {
      layout.columnPinning = cleanedPinning;
      changed = true;
    }
  }

  if (
    layout.type === "kanban" &&
    layout.groupByPropertyId &&
    !isInternal(layout.groupByPropertyId) &&
    !propertyIds.includes(layout.groupByPropertyId)
  ) {
    layout.groupByPropertyId = undefined;
    changed = true;
  }

  if (layout.type === "calendar") {
    const valid = (id: string) => isInternal(id) || propertyIds.includes(id);
    if (!valid(layout.datePropertyId)) {
      layout.datePropertyId = "_created-at";
      changed = true;
    }
    if (layout.endDatePropertyId && !valid(layout.endDatePropertyId)) {
      layout.endDatePropertyId = undefined;
      changed = true;
    }
    if (layout.additionalDatePropertyIds) {
      const cleaned = layout.additionalDatePropertyIds.filter(valid);
      if (cleaned.length !== layout.additionalDatePropertyIds.length) {
        layout.additionalDatePropertyIds = cleaned;
        changed = true;
      }
    }
  }

  if (layout.type === "timeline") {
    const valid = (id: string) => isInternal(id) || propertyIds.includes(id);
    if (!valid(layout.startDatePropertyId)) {
      layout.startDatePropertyId = "_created-at";
      changed = true;
    }
    if (!valid(layout.endDatePropertyId)) {
      layout.endDatePropertyId = "_created-at";
      changed = true;
    }
    if (
      layout.groupByPropertyId &&
      !isInternal(layout.groupByPropertyId) &&
      !propertyIds.includes(layout.groupByPropertyId)
    ) {
      layout.groupByPropertyId = undefined;
      changed = true;
    }
  }

  return changed;
};

export const hasDuplicateSorts = (
  sorts: readonly { propertyId: string }[],
): boolean => {
  const seen = new Set<string>();
  for (const s of sorts) {
    if (seen.has(s.propertyId)) {
      return true;
    }
    seen.add(s.propertyId);
  }
  return false;
};

export const hasMultipleKindFilters = (
  filters: readonly { field: string }[],
): boolean => filters.filter((f) => f.field === "kind").length > 1;

export const convertLayout = (
  source: ViewLayout,
  targetType: ViewLayoutType,
): ViewLayout => {
  const base: ViewLayoutBase = {
    filters: source.filters,
    sorts: source.sorts,
    hiddenProperties: source.hiddenProperties,
  };

  if (targetType === "table") {
    const columnOrder = source.type === "table" ? source.columnOrder : [];
    const columnPinning = source.type === "table" ? source.columnPinning : [];
    return { type: "table", ...base, columnOrder, columnPinning };
  }

  if (targetType === "kanban") {
    return { type: "kanban", ...base };
  }

  if (targetType === "calendar") {
    const prev = source.type === "calendar" ? source : null;
    return {
      type: "calendar",
      ...base,
      datePropertyId: prev?.datePropertyId ?? "_created-at",
      mode: prev?.mode ?? "month",
    };
  }

  if (targetType === "timeline") {
    const prev = source.type === "timeline" ? source : null;
    return {
      type: "timeline",
      ...base,
      startDatePropertyId: prev?.startDatePropertyId ?? "_created-at",
      endDatePropertyId: prev?.endDatePropertyId ?? "_created-at",
      zoom: prev?.zoom ?? "month",
      showTable: prev?.showTable ?? false,
    };
  }

  // overview, filesystem
  return { type: targetType, ...base };
};
