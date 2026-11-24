import { lazy, Suspense } from "react";

import { registerInspectorView } from "@/components/inspector/view-registry";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import type { ToolDetailPayload } from "@/routes/knowledge/-components/catalogue/tool-detail-view";

// The view itself loads only when a tab opens; the registration is what the
// inspector needs to restore a tab, so it stays with the Tools route.
const LazyToolDetailView = lazy(async () => {
  const module =
    await import("@/routes/knowledge/-components/catalogue/tool-detail-view");
  return { default: module.ToolDetailView };
});

const LazyToolDetailRailIcon = lazy(async () => {
  const module =
    await import("@/routes/knowledge/-components/catalogue/tool-detail-view");
  return { default: module.ToolDetailRailIcon };
});

// Tool-detail tabs live next to a route; they auto-close when the
// user navigates away from `/knowledge/tools` so the rail doesn't
// keep stale entries for a page the user has left.
const isToolDetailPayload = (value: unknown): value is ToolDetailPayload => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (
    !("kind" in value) ||
    !("slug" in value) ||
    !("organizationId" in value) ||
    !("iconHint" in value)
  ) {
    return false;
  }
  if (
    value.kind !== "skill" &&
    value.kind !== "mcp" &&
    value.kind !== "native-tool"
  ) {
    return false;
  }
  if (
    typeof value.slug !== "string" ||
    typeof value.organizationId !== "string"
  ) {
    return false;
  }
  const iconHint = value.iconHint;
  if (typeof iconHint !== "object" || iconHint === null) {
    return false;
  }
  return (
    "icon" in iconHint &&
    (iconHint.icon === null || typeof iconHint.icon === "string") &&
    "iconUrl" in iconHint &&
    (iconHint.iconUrl === null || typeof iconHint.iconUrl === "string")
  );
};

function ToolDetailViewRenderer(
  props: InspectorViewRenderProps<ToolDetailPayload>,
) {
  return (
    <Suspense fallback={null}>
      <LazyToolDetailView {...props} />
    </Suspense>
  );
}

function ToolDetailRailIconRenderer(
  props: InspectorRailIconProps<ToolDetailPayload>,
) {
  return (
    <Suspense fallback={null}>
      <LazyToolDetailRailIcon {...props} />
    </Suspense>
  );
}

registerInspectorView<ToolDetailPayload>({
  type: "tool-detail",
  render: ToolDetailViewRenderer,
  railIcon: ToolDetailRailIconRenderer,
  validate: isToolDetailPayload,
});
