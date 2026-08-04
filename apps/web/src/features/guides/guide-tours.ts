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
    estMinutes: 4,
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
        // The only step that opens anything: (+) is a pure disclosure trigger,
        // so clicking it on the user's behalf shows the menu and nothing else.
        // The five steps below explain the options it reveals.
        anchor: GUIDE_ANCHORS.chatToolsButton,
        titleKey: "guides.tours.chat.steps.plusMenu.title",
        bodyKey: "guides.tours.chat.steps.plusMenu.body",
        whenKey: "guides.tours.chat.steps.plusMenu.when",
        placement: "top",
        seed: { kind: "none" },
        interaction: { kind: "open" },
      },
      {
        anchor: GUIDE_ANCHORS.chatMenuAttach,
        titleKey: "guides.tours.chat.steps.attach.title",
        bodyKey: "guides.tours.chat.steps.attach.body",
        whenKey: "guides.tours.chat.steps.attach.when",
        placement: "right",
        seed: { kind: "none" },
      },
      {
        anchor: GUIDE_ANCHORS.chatMenuModels,
        titleKey: "guides.tours.chat.steps.models.title",
        bodyKey: "guides.tours.chat.steps.models.body",
        whenKey: "guides.tours.chat.steps.models.when",
        placement: "right",
        seed: { kind: "none" },
      },
      {
        anchor: GUIDE_ANCHORS.chatMenuSkills,
        titleKey: "guides.tours.chat.steps.skills.title",
        bodyKey: "guides.tours.chat.steps.skills.body",
        whenKey: "guides.tours.chat.steps.skills.when",
        placement: "right",
        seed: { kind: "none" },
      },
      {
        anchor: GUIDE_ANCHORS.chatMenuContext,
        titleKey: "guides.tours.chat.steps.context.title",
        bodyKey: "guides.tours.chat.steps.context.body",
        whenKey: "guides.tours.chat.steps.context.when",
        placement: "right",
        seed: { kind: "none" },
      },
      {
        anchor: GUIDE_ANCHORS.chatMenuMcp,
        titleKey: "guides.tours.chat.steps.mcp.title",
        bodyKey: "guides.tours.chat.steps.mcp.body",
        whenKey: "guides.tours.chat.steps.mcp.when",
        placement: "right",
        seed: { kind: "none" },
      },
      {
        // Back out on the page behind the menu: reaching this step is what
        // closes the (+) menu the tour opened.
        anchor: GUIDE_ANCHORS.chatAnonymize,
        titleKey: "guides.tours.chat.steps.anonymize.title",
        bodyKey: "guides.tours.chat.steps.anonymize.body",
        whenKey: "guides.tours.chat.steps.anonymize.when",
        placement: "top",
        seed: { kind: "none" },
      },
      {
        anchor: GUIDE_ANCHORS.chatSend,
        titleKey: "guides.tours.chat.steps.send.title",
        bodyKey: "guides.tours.chat.steps.send.body",
        whenKey: "guides.tours.chat.steps.send.when",
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
