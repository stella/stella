import { lazy, Suspense } from "react";
import type { ComponentType, ReactElement } from "react";

import { panic } from "better-result";

import type { VisualName } from "./-visual-metadata";

type VisualLoader = {
  load: () => Promise<{ default: ComponentType }>;
};

const visualLoaders = {
  "browser-extension-chip": {
    load: async () => {
      const { BrowserExtensionChipPlayground } =
        await import("./-components/browser-extension-chip-playground");
      return { default: BrowserExtensionChipPlayground };
    },
  },
  "appeal-reviews": {
    load: async () => {
      const { AppealReviewsPlayground } =
        await import("./-components/appeal-reviews-playground");
      return { default: AppealReviewsPlayground };
    },
  },
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
  "overview-stat-cards": {
    load: async () => {
      const { OverviewStatCardsPlayground } =
        await import("./-components/overview-stat-cards-playground");
      return { default: OverviewStatCardsPlayground };
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
  "outcome-screen": {
    load: async () => {
      const { OutcomeScreenPlayground } =
        await import("./-components/outcome-screen-playground");
      return { default: OutcomeScreenPlayground };
    },
  },
  "upload-rejections": {
    load: async () => {
      const { UploadRejectionsPlayground } =
        await import("./-components/upload-rejections-playground");
      return { default: UploadRejectionsPlayground };
    },
  },
  "document-naming": {
    load: async () => {
      const { DocumentNamingPlayground } =
        await import("./-components/document-naming-playground");
      return { default: DocumentNamingPlayground };
    },
  },
  "page-crop": {
    load: async () => {
      const { PageCropPlayground } =
        await import("./-components/page-crop-playground");
      return { default: PageCropPlayground };
    },
  },
  "pdf-fit-width": {
    load: async () => {
      const { PdfFitWidthPlayground } =
        await import("./-components/pdf-fit-width-playground");
      return { default: PdfFitWidthPlayground };
    },
  },
  "chat-long-paste": {
    load: async () => {
      const { ChatLongPastePlayground } =
        await import("./-components/chat-long-paste-playground");
      return { default: ChatLongPastePlayground };
    },
  },
  "button-label": {
    load: async () => {
      const { ButtonLabelPlayground } =
        await import("./-components/button-label-playground");
      return { default: ButtonLabelPlayground };
    },
  },
  "sortable-head": {
    load: async () => {
      const { SortableHeadPlayground } =
        await import("./-components/sortable-head-playground");
      return { default: SortableHeadPlayground };
    },
  },
  "menu-commits": {
    load: async () => {
      const { MenuCommitsPlayground } =
        await import("./-components/menu-commits-playground");
      return { default: MenuCommitsPlayground };
    },
  },
  "storm-watch": {
    load: async () => {
      const { StormWatchPlayground } =
        await import("./-components/storm-watch-playground");
      return { default: StormWatchPlayground };
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
  "chat-citation-chips": {
    load: async () => {
      const [{ ChatCitationsPlayground }, { CHAT_CITATION_CHIPS_CASSETTE }] =
        await Promise.all([
          import("./-components/chat-citations-playground"),
          import("./-components/chat-citation-chips-cassette"),
        ]);
      return {
        default: () => (
          <ChatCitationsPlayground cassette={CHAT_CITATION_CHIPS_CASSETTE} />
        ),
      };
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
  "chat-answer-footer": {
    load: async () => {
      const [{ ChatCitationsPlayground }, { CHAT_ANSWER_FOOTER_CASSETTE }] =
        await Promise.all([
          import("./-components/chat-citations-playground"),
          import("./-components/chat-answer-footer-cassette"),
        ]);
      return {
        default: () => (
          <ChatCitationsPlayground cassette={CHAT_ANSWER_FOOTER_CASSETTE} />
        ),
      };
    },
  },
  "chat-matter-reads": {
    load: async () => {
      const { ChatMatterReadsPlayground } =
        await import("./-components/chat-matter-reads-playground");
      return { default: ChatMatterReadsPlayground };
    },
  },
  "chat-answer-typography": {
    load: async () => {
      const [{ ChatCitationsPlayground }, { CHAT_ANSWER_TYPOGRAPHY_CASSETTE }] =
        await Promise.all([
          import("./-components/chat-citations-playground"),
          import("./-components/chat-answer-typography-cassette"),
        ]);
      return {
        default: () => (
          <ChatCitationsPlayground cassette={CHAT_ANSWER_TYPOGRAPHY_CASSETTE} />
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
  "chat-follow-ups": {
    load: async () => {
      const { ChatFollowUpsPlayground } =
        await import("./-components/chat-follow-ups-playground");
      return { default: ChatFollowUpsPlayground };
    },
  },
  "ask-user": {
    load: async () => {
      const { AskUserPlayground } =
        await import("./-components/ask-user-playground");
      return { default: AskUserPlayground };
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
  "inspector-phone-header": {
    load: async () => {
      const { InspectorPhoneHeaderPlayground } =
        await import("./-components/inspector-phone-header-playground");
      return { default: InspectorPhoneHeaderPlayground };
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
    <Suspense fallback={null}>
      <Layout>{element}</Layout>
    </Suspense>
  );
};
