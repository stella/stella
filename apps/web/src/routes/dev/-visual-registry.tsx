import { lazy, Suspense } from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";

import { panic } from "better-result";
import * as v from "valibot";

import { routeSearchSchema } from "@/route-search-params";

import { visualRegistry } from "./-visual-metadata";
import type { VisualName } from "./-visual-metadata";

type VisualLoader = {
  load: () => Promise<{ default: ComponentType }>;
};

const visualLoaders = {
  "mcp-reconnect": {
    load: async () => {
      const { McpReconnectPlayground } =
        await import("./-components/mcp-reconnect-playground");
      return { default: McpReconnectPlayground };
    },
  },
  "task-metadata": {
    load: async () => {
      const { TaskMetadataPlayground } =
        await import("./-components/task-metadata-playground");
      return { default: TaskMetadataPlayground };
    },
  },
  "column-composer": {
    load: async () => {
      const { ColumnComposerPlayground } =
        await import("./-components/column-composer-playground");
      return { default: ColumnComposerPlayground };
    },
  },
  "handoff-confirmation": {
    load: async () => {
      const { HandoffConfirmationPlayground } =
        await import("./-components/handoff-confirmation-playground");
      return { default: HandoffConfirmationPlayground };
    },
  },
  "case-law-text-availability": {
    load: async () => {
      const { CaseLawTextAvailabilityPlayground } =
        await import("./-components/case-law-text-availability-playground");
      return { default: CaseLawTextAvailabilityPlayground };
    },
  },
  "hungarian-decision": {
    load: async () => {
      const { HungarianDecisionPlayground } =
        await import("./-components/hungarian-decision-playground");
      return { default: HungarianDecisionPlayground };
    },
  },
  "table-chart": {
    load: async () => {
      const { TableChartPlayground } =
        await import("./-components/table-chart-playground");
      return { default: TableChartPlayground };
    },
  },
  "oauth-consent": {
    load: async () => {
      const { OAuthConsentPlayground } =
        await import("./-components/oauth-consent-playground");
      return { default: OAuthConsentPlayground };
    },
  },
  "upload-rejections": {
    load: async () => {
      const { UploadRejectionsPlayground } =
        await import("./-components/upload-rejections-playground");
      return { default: UploadRejectionsPlayground };
    },
  },
  "page-crop": {
    load: async () => {
      const { PageCropPlayground } =
        await import("./-components/page-crop-playground");
      return { default: PageCropPlayground };
    },
  },
  "chat-long-paste": {
    load: async () => {
      const { ChatLongPastePlayground } =
        await import("./-components/chat-long-paste-playground");
      return { default: ChatLongPastePlayground };
    },
  },
  "chat-composer-reference": {
    load: async () => {
      const { ChatComposerReferencePlayground } =
        await import("./-components/chat-composer-reference-playground");
      return { default: ChatComposerReferencePlayground };
    },
  },
  "chat-continuation-error": {
    load: async () => {
      const { ChatContinuationErrorPlayground } =
        await import("./-components/chat-continuation-error-playground");
      return { default: ChatContinuationErrorPlayground };
    },
  },
  "chat-status": {
    load: async () => {
      const { ChatStatusPlayground } =
        await import("./-components/chat-status-playground");
      return { default: ChatStatusPlayground };
    },
  },
  "chat-citations": {
    load: async () => {
      const { ChatCitationsPlayground } =
        await import("./-components/chat-citations-playground");
      return { default: ChatCitationsPlayground };
    },
  },
  "chat-statute-citations": {
    load: async () => {
      const [{ ChatCitationsPlayground }, { CHAT_STATUTE_CITATIONS_CASSETTE }] =
        await Promise.all([
          import("./-components/chat-citations-playground"),
          import("./-components/chat-statute-citations-cassette"),
        ]);
      return {
        default: () => (
          <ChatCitationsPlayground cassette={CHAT_STATUTE_CITATIONS_CASSETTE} />
        ),
      };
    },
  },
  "chat-link-icons": {
    load: async () => {
      const { ChatLinkIconsPlayground } =
        await import("./-components/chat-link-icons-playground");
      return { default: ChatLinkIconsPlayground };
    },
  },
  "reader-answers": {
    load: async () => {
      const { ReaderAnswersPlayground } =
        await import("./-components/reader-answers-playground");
      return { default: ReaderAnswersPlayground };
    },
  },
  "reader-selection": {
    load: async () => {
      const { ReaderSelectionPlayground } =
        await import("./-components/reader-selection-playground");
      return { default: ReaderSelectionPlayground };
    },
  },
  "chat-history-decision": {
    load: async () => {
      const { ChatHistoryDecisionPlayground } =
        await import("./-components/chat-history-decision-playground");
      return { default: ChatHistoryDecisionPlayground };
    },
  },
  "answer-edit": {
    load: async () => {
      const { AnswerEditPlayground } =
        await import("./-components/answer-edit-playground");
      return { default: AnswerEditPlayground };
    },
  },
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
  "provision-header": {
    load: async () => {
      const { ProvisionHeaderPlayground } =
        await import("./-components/provision-header-playground");
      return { default: ProvisionHeaderPlayground };
    },
  },
  "workspace-table": {
    load: async () => {
      const { WorkspaceTablePlayground } =
        await import("./-components/workspace-table-playground");
      return { default: WorkspaceTablePlayground };
    },
  },
  "public-law-toolbar": {
    load: async () => {
      const { PublicLawToolbarPlayground } =
        await import("./-components/public-law-toolbar-playground");
      return { default: PublicLawToolbarPlayground };
    },
  },
} as const satisfies Record<VisualName, VisualLoader>;

const isVisualName = (input: unknown): input is VisualName =>
  typeof input === "string" && Object.hasOwn(visualRegistry, input);

export const visualSearchSchema = routeSearchSchema({
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
