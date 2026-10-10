import { lazy, Suspense } from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";

import { panic } from "better-result";
import * as v from "valibot";

import { visualRegistry } from "./-visual-metadata";
import type { VisualName } from "./-visual-metadata";

type VisualLoader = {
  load: () => Promise<{ default: ComponentType }>;
};

const visualLoaders = {
  autocomplete: {
    load: async () => {
      const { AutocompletePlayground } =
        await import("./-components/autocomplete-playground");
      return { default: AutocompletePlayground };
    },
  },
  ui: {
    load: async () => {
      const { UiPlayground } = await import("./-components/ui-playground");
      return { default: UiPlayground };
    },
  },
  "control-sizes": {
    load: async () => {
      const { ControlSizesPlayground } =
        await import("./-components/control-sizes-playground");
      return { default: ControlSizesPlayground };
    },
  },
  "inspector-pane": {
    load: async () => {
      const { InspectorPanePlayground } =
        await import("./-components/inspector-pane-playground");
      return { default: InspectorPanePlayground };
    },
  },
  "playbook-editor": {
    load: async () => {
      const { PlaybookEditorPlayground } =
        await import("./-components/playbook-editor-playground");
      return { default: PlaybookEditorPlayground };
    },
  },
  "shell-pending": {
    load: async () => {
      const { ProtectedPendingSkeleton } =
        await import("../-protected-pending-skeleton");
      return { default: ProtectedPendingSkeleton };
    },
  },
  "workspace-table": {
    load: async () => {
      const { WorkspaceTablePlayground } =
        await import("./-components/workspace-table-playground");
      return { default: WorkspaceTablePlayground };
    },
  },
} as const satisfies Record<VisualName, VisualLoader>;

const isVisualName = (input: unknown): input is VisualName =>
  typeof input === "string" && Object.hasOwn(visualRegistry, input);

export const visualSearchSchema = v.object({
  visual: v.optional(v.custom<VisualName>(isVisualName)),
});

const lazyVisual = ({ load }: VisualLoader) => {
  const Component = lazy(load);
  return <Component />;
};

const visualElements = Object.freeze(
  Object.fromEntries(
    Object.entries(visualLoaders).map(
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
