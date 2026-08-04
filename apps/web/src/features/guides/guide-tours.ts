import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import { GUIDE_TOUR_IDS, type GuideTour } from "@/features/guides/guide-types";

// Compiled-in, typed registry: no fetch on drawer open or route load. The
// checklist renders these in order. `as const satisfies` validates every
// translation key and anchor/route against its closed union without widening.
//
// The Chat tour is fully wired end-to-end (its anchors are registered on the
// real composer). Documents, Playbooks, Workflows, and Tabular review are
// defined with their anchors but not yet registered on their surfaces; the
// runner skips their steps gracefully (and logs the skip) until wiring lands.
export const GUIDE_TOURS = [
  {
    id: GUIDE_TOUR_IDS.chat,
    titleKey: "guides.tours.chat.title",
    descriptionKey: "guides.tours.chat.description",
    estMinutes: 2,
    steps: [
      {
        anchor: GUIDE_ANCHORS.chatComposer,
        route: "/chat",
        titleKey: "guides.tours.chat.steps.composer.title",
        bodyKey: "guides.tours.chat.steps.composer.body",
        placement: "top",
        // The composer is a rich-text editor, not a plain input, so the
        // guarded seed is skipped at runtime — it demonstrates the fill-input
        // branch and its graceful no-op, not a wired example.
        seed: {
          kind: "fill-input",
          anchor: GUIDE_ANCHORS.chatComposer,
          valueKey: "guides.tours.chat.examplePrompt",
        },
      },
      {
        anchor: GUIDE_ANCHORS.chatToolsButton,
        titleKey: "guides.tours.chat.steps.tools.title",
        bodyKey: "guides.tours.chat.steps.tools.body",
        placement: "top",
        seed: { kind: "none" },
      },
      {
        anchor: GUIDE_ANCHORS.chatSend,
        titleKey: "guides.tours.chat.steps.send.title",
        bodyKey: "guides.tours.chat.steps.send.body",
        placement: "left",
        seed: { kind: "none" },
      },
    ],
  },
  {
    id: GUIDE_TOUR_IDS.documents,
    titleKey: "guides.tours.documents.title",
    descriptionKey: "guides.tours.documents.description",
    estMinutes: 3,
    steps: [
      {
        anchor: GUIDE_ANCHORS.documentsUpload,
        titleKey: "guides.tours.documents.steps.upload.title",
        bodyKey: "guides.tours.documents.steps.upload.body",
        placement: "bottom",
        seed: { kind: "none" },
      },
      {
        anchor: GUIDE_ANCHORS.documentsList,
        titleKey: "guides.tours.documents.steps.browse.title",
        bodyKey: "guides.tours.documents.steps.browse.body",
        placement: "right",
        seed: { kind: "none" },
      },
    ],
  },
  {
    id: GUIDE_TOUR_IDS.playbooks,
    titleKey: "guides.tours.playbooks.title",
    descriptionKey: "guides.tours.playbooks.description",
    estMinutes: 3,
    steps: [
      {
        anchor: GUIDE_ANCHORS.playbooksCreate,
        titleKey: "guides.tours.playbooks.steps.create.title",
        bodyKey: "guides.tours.playbooks.steps.create.body",
        placement: "bottom",
        seed: { kind: "none" },
      },
    ],
  },
  {
    id: GUIDE_TOUR_IDS.workflows,
    titleKey: "guides.tours.workflows.title",
    descriptionKey: "guides.tours.workflows.description",
    estMinutes: 4,
    steps: [
      {
        anchor: GUIDE_ANCHORS.workflowsCreate,
        route: "/knowledge/workflows",
        titleKey: "guides.tours.workflows.steps.create.title",
        bodyKey: "guides.tours.workflows.steps.create.body",
        placement: "bottom",
        seed: { kind: "none" },
      },
    ],
  },
  {
    id: GUIDE_TOUR_IDS.tabularReview,
    titleKey: "guides.tours.tabularReview.title",
    descriptionKey: "guides.tours.tabularReview.description",
    estMinutes: 4,
    steps: [
      {
        anchor: GUIDE_ANCHORS.tabularReviewAddColumn,
        titleKey: "guides.tours.tabularReview.steps.addColumn.title",
        bodyKey: "guides.tours.tabularReview.steps.addColumn.body",
        placement: "bottom",
        seed: { kind: "none" },
      },
    ],
  },
] as const satisfies readonly GuideTour[];
