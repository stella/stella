import { nanoid } from "nanoid";
import { actor, event } from "rivetkit";

import {
  convertViewInputSchema,
  createViewInputSchema,
  getViewsInputSchema,
  reorderViewsInputSchema,
  updateViewInputSchema,
} from "@/api/handlers/registry/actors/views/schema";
import type {
  ConvertViewInput,
  CreateViewInput,
  GetViewsInput,
  ReorderViewsInput,
  UpdateViewInput,
  ViewLayout,
  ViewLayoutBase,
  ViewLayoutType,
} from "@/api/handlers/registry/actors/views/schema";
import {
  createUserError,
  validateActorInput,
  validateActorSession,
} from "@/api/handlers/registry/utils";
import { LIMITS } from "@/api/lib/limits";
import { DEFAULT_VIEWS, REQUIRED_VIEW_LAYOUTS } from "@/api/lib/views";

type ViewStateV1 = {
  version: 1;
  id: string;
  name: string;
  layout: ViewLayout;
  position: number;
  createdAt: string;
};

type ViewState = ViewStateV1;

const sortedViews = (views: ViewState[]): ViewState[] =>
  views.toSorted((a, b) => a.position - b.position);

const cleanStalePropertyIds = (
  layout: ViewLayout,
  propertyIds: Set<string>,
): boolean => {
  let changed = false;

  const isInternal = (id: string) => id.startsWith("_");

  const cleanedHidden = layout.hiddenProperties.filter(
    (id) => propertyIds.has(id) || isInternal(id),
  );
  if (cleanedHidden.length !== layout.hiddenProperties.length) {
    layout.hiddenProperties = cleanedHidden;
    changed = true;
  }

  const cleanedSorts = layout.sorts.filter(
    (s) => propertyIds.has(s.propertyId) || isInternal(s.propertyId),
  );
  if (cleanedSorts.length !== layout.sorts.length) {
    layout.sorts = cleanedSorts;
    changed = true;
  }

  const cleanedFilters = layout.filters.filter(
    (f) =>
      f.field === "kind" ||
      f.field === "builtin" ||
      (f.field === "property" && propertyIds.has(f.propertyId)),
  );
  if (cleanedFilters.length !== layout.filters.length) {
    layout.filters = cleanedFilters;
    changed = true;
  }

  if (layout.type === "table") {
    const cleanedOrder = layout.columnOrder.filter(
      (id) => propertyIds.has(id) || isInternal(id),
    );
    if (cleanedOrder.length !== layout.columnOrder.length) {
      layout.columnOrder = cleanedOrder;
      changed = true;
    }

    // oxlint-disable-next-line typescript/strict-boolean-expressions -- columnPinning array check
    if (layout.columnPinning) {
      const cleanedPinning = layout.columnPinning.filter(
        (id) => propertyIds.has(id) || isInternal(id),
      );
      if (cleanedPinning.length !== layout.columnPinning.length) {
        layout.columnPinning = cleanedPinning;
        changed = true;
      }
    }
  }

  if (
    layout.type === "kanban" &&
    layout.groupByPropertyId &&
    !propertyIds.has(layout.groupByPropertyId)
  ) {
    layout.groupByPropertyId = undefined;
    changed = true;
  }

  if (layout.type === "calendar") {
    const valid = (id: string) => isInternal(id) || propertyIds.has(id);
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
    const valid = (id: string) => isInternal(id) || propertyIds.has(id);
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
      !propertyIds.has(layout.groupByPropertyId)
    ) {
      layout.groupByPropertyId = undefined;
      changed = true;
    }
  }

  return changed;
};

const convertLayout = (
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

const hasDuplicateSorts = (sorts: { propertyId: string }[]): boolean => {
  const seen = new Set<string>();
  for (const s of sorts) {
    if (seen.has(s.propertyId)) {
      return true;
    }
    seen.add(s.propertyId);
  }
  return false;
};

const hasMultipleKindFilters = (filters: { field: string }[]): boolean =>
  filters.filter((f) => f.field === "kind").length > 1;

type ActorState = {
  views: ViewState[];
};

export const viewsActor = actor({
  state: {
    views: [] as ViewState[],
  } satisfies ActorState,
  events: {
    "views-changed": event<{ views: ViewState[] }>(),
    "view-deleted": event<{ viewId: string }>(),
  },
  createConnState: async (c, params) =>
    await validateActorSession(c.key, params),
  onWake: (c) => {
    if (c.state.views.length > 0) {
      return;
    }

    c.state.views = DEFAULT_VIEWS.map((v) => ({
      version: 1 as const,
      id: nanoid(),
      name: v.name,
      layout: v.layout,
      position: v.position,
      createdAt: new Date().toISOString(),
    }));
  },
  actions: {
    getViews: (c, input: GetViewsInput): ViewState[] => {
      const { propertyIds } = validateActorInput(getViewsInputSchema, input);

      // oxlint-disable-next-line typescript/strict-boolean-expressions -- propertyIds optional
      if (propertyIds) {
        for (const view of c.state.views) {
          cleanStalePropertyIds(view.layout, new Set(propertyIds));
        }
      }

      return sortedViews(c.state.views);
    },
    createView: (c, input: CreateViewInput): ViewState => {
      const { id, name, layout } = validateActorInput(
        createViewInputSchema,
        input,
      );

      if (hasDuplicateSorts(layout.sorts)) {
        throw createUserError("invalid-arguments", {
          metadata: { reason: "Duplicate sort property" },
        });
      }

      if (hasMultipleKindFilters(layout.filters)) {
        throw createUserError("invalid-arguments", {
          metadata: { reason: "Multiple kind filters" },
        });
      }

      if (c.state.views.length >= LIMITS.viewsCount) {
        throw createUserError("invalid-arguments", {
          metadata: { reason: "Views limit reached" },
        });
      }

      const maxPosition = c.state.views.reduce(
        (max, v) => (v.position > max ? v.position : max),
        -1,
      );

      const view: ViewState = {
        version: 1,
        id,
        name,
        layout,
        position: maxPosition + 1,
        createdAt: new Date().toISOString(),
      };

      c.state.views.push(view);

      c.broadcast("views-changed", { views: [view] });

      return view;
    },

    updateView: (c, input: UpdateViewInput): void => {
      const { viewId, name, layout } = validateActorInput(
        updateViewInputSchema,
        input,
      );
      const view = c.state.views.find((v) => v.id === viewId);

      if (!view) {
        throw createUserError("invalid-arguments");
      }

      const idx = c.state.views.indexOf(view);

      if (name) {
        view.name = name;
      }

      if (layout) {
        if (hasDuplicateSorts(layout.sorts)) {
          throw createUserError("invalid-arguments", {
            metadata: { reason: "Duplicate sort property" },
          });
        }
        if (hasMultipleKindFilters(layout.filters)) {
          throw createUserError("invalid-arguments", {
            metadata: { reason: "Multiple kind filters" },
          });
        }

        if (view.layout.type !== layout.type) {
          throw createUserError("invalid-arguments", {
            metadata: { reason: "Cannot change view type" },
          });
        }

        view.layout = layout;
      }

      c.state.views[idx] = view;

      c.broadcast("views-changed", { views: [view] });
    },

    convertView: (c, input: ConvertViewInput): ViewState => {
      const { viewId, targetType } = validateActorInput(
        convertViewInputSchema,
        input,
      );
      const view = c.state.views.find((v) => v.id === viewId);

      if (!view) {
        throw createUserError("invalid-arguments");
      }

      if (view.layout.type === targetType) {
        throw createUserError("invalid-arguments", {
          metadata: { reason: "View is already this layout type" },
        });
      }

      view.layout = convertLayout(view.layout, targetType);

      c.broadcast("views-changed", { views: [view] });

      return view;
    },

    deleteView: (c, input: { viewId: string }): void => {
      const targetIdx = c.state.views.findIndex((v) => v.id === input.viewId);

      if (targetIdx === -1) {
        throw createUserError("invalid-arguments");
      }

      if (c.state.views.length <= 1) {
        throw createUserError("invalid-arguments", {
          metadata: {
            reason: "Cannot delete the last view",
          },
        });
      }

      const target = c.state.views[targetIdx];
      if (!target) {
        throw createUserError("invalid-arguments");
      }
      if (REQUIRED_VIEW_LAYOUTS.includes(target.layout.type)) {
        const sameLayoutCount = c.state.views.filter(
          (v) => v.layout.type === target.layout.type,
        ).length;

        if (sameLayoutCount <= 1) {
          throw createUserError("invalid-arguments", {
            metadata: {
              reason: `Cannot delete the last ${target.layout.type} view`,
            },
          });
        }
      }

      c.state.views.splice(targetIdx, 1);

      c.broadcast("view-deleted", {
        viewId: input.viewId,
      });
    },

    reorderViews: (c, input: ReorderViewsInput): void => {
      const { viewIds } = validateActorInput(reorderViewsInputSchema, input);

      if (new Set(viewIds).size !== viewIds.length) {
        throw createUserError("invalid-arguments");
      }

      if (viewIds.length !== c.state.views.length) {
        throw createUserError("invalid-arguments", {
          metadata: {
            reason: "View IDs must include all views in the workspace",
          },
        });
      }

      for (let i = 0; i < viewIds.length; i++) {
        const view = c.state.views.find((v) => v.id === viewIds[i]);
        if (view) {
          view.position = i;
        }
      }

      c.broadcast("views-changed", {
        views: sortedViews(c.state.views),
      });
    },

    destroy: (c): { success: boolean } => {
      c.destroy();
      return { success: true };
    },
  },
});
