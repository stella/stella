import { lazy, Suspense } from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";

import { panic } from "better-result";
import * as v from "valibot";

export type VisualLayout =
  | "plain"
  | "control-sizes"
  | "inspector-pane"
  | "workspace-table";

type VisualEntry = {
  layout: VisualLayout;
  label: string;
  load: () => Promise<{ default: ComponentType }>;
};

export const visualRegistry = {
  autocomplete: {
    label: "Autocomplete",
    layout: "plain",
    load: async () => {
      const { AutocompletePlayground } =
        await import("@/components/dev/autocomplete-playground");
      return { default: AutocompletePlayground };
    },
  },
  ui: {
    label: "UI components",
    layout: "plain",
    load: async () => {
      const { UiPlayground } = await import("./-components/ui-playground");
      return { default: UiPlayground };
    },
  },
  "control-sizes": {
    label: "Control sizes",
    layout: "control-sizes",
    load: async () => {
      const { ControlSizesPlayground } =
        await import("./-components/control-sizes-playground");
      return { default: ControlSizesPlayground };
    },
  },
  "inspector-pane": {
    label: "Inspector pane",
    layout: "inspector-pane",
    load: async () => {
      const { InspectorPanePlayground } =
        await import("./-components/inspector-pane-playground");
      return { default: InspectorPanePlayground };
    },
  },
  "shell-pending": {
    label: "Shell pending",
    layout: "plain",
    load: async () => {
      const { ProtectedPendingSkeleton } =
        await import("../-protected-pending-skeleton");
      return { default: ProtectedPendingSkeleton };
    },
  },
  "workspace-table": {
    label: "Workspace table",
    layout: "workspace-table",
    load: async () => {
      const { WorkspaceTablePlayground } =
        await import("./-components/workspace-table-playground");
      return { default: WorkspaceTablePlayground };
    },
  },
} as const satisfies Record<string, VisualEntry>;

export type VisualName = keyof typeof visualRegistry;

const isVisualName = (input: unknown): input is VisualName =>
  typeof input === "string" && Object.hasOwn(visualRegistry, input);

export const visualSearchSchema = v.object({
  visual: v.optional(v.custom<VisualName>(isVisualName)),
});

const lazyVisual = ({ load }: VisualEntry) => {
  const Component = lazy(load);
  return <Component />;
};

const visualElements = Object.freeze(
  Object.fromEntries(
    Object.entries(visualRegistry).map(
      ([name, entry]) => [name, lazyVisual(entry)] as const,
    ),
  ),
);

type FixtureSectionProps = {
  visual: VisualName;
  children: ReactNode;
};

export const FixtureSection = ({ visual, children }: FixtureSectionProps) => (
  <section
    className="bg-background flex min-h-0 flex-1 flex-col"
    data-playground-section={`fixture:${visual}`}
  >
    <header className="text-muted-foreground shrink-0 px-4 py-2 text-xs">
      Fixture: {visualRegistry[visual].label}
    </header>
    {children}
  </section>
);

type VisualPlaygroundProps = {
  visual: VisualName;
  layout: ComponentType<{ children: ReactElement }>;
};

export const VisualPlayground = ({
  visual,
  layout: Layout,
}: VisualPlaygroundProps) => {
  const element = visualElements[visual];
  if (element === undefined) {
    return panic(`Visual fixture is not registered: ${visual}`);
  }

  return (
    <FixtureSection visual={visual}>
      <Suspense fallback={null}>
        <Layout>{element}</Layout>
      </Suspense>
    </FixtureSection>
  );
};
