import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import { GUIDE_TOUR_IDS, type GuideTour } from "@/features/guides/guide-types";

// Compiled-in, typed registry: no fetch on drawer open or route load. The
// checklist renders these in order. `as const satisfies` validates every
// translation key and anchor/route against its closed union without widening.
//
export const GUIDE_TOURS = [
  {
    id: GUIDE_TOUR_IDS.chat,
    titleKey: "guides.tours.chat.title",
    descriptionKey: "guides.tours.chat.description",
    estMinutes: 3,
    steps: [
      {
        anchor: GUIDE_ANCHORS.chatComposer,
        route: { type: "static", to: "/chat" },
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
        // The two steps below explain the everyday options it reveals; the
        // rest of the menu is the "chat power features" tour.
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
        anchor: GUIDE_ANCHORS.chatMenuContext,
        titleKey: "guides.tours.chat.steps.context.title",
        bodyKey: "guides.tours.chat.steps.context.body",
        whenKey: "guides.tours.chat.steps.context.when",
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
    // The rest of the (+) menu, for a second visit: everything here changes
    // how the assistant answers rather than what it reads. The tour ends
    // inside the menu; the runner closes it on every exit.
    id: GUIDE_TOUR_IDS.chatPower,
    titleKey: "guides.tours.chatPower.title",
    descriptionKey: "guides.tours.chatPower.description",
    estMinutes: 2,
    steps: [
      {
        anchor: GUIDE_ANCHORS.chatToolsButton,
        route: { type: "static", to: "/chat" },
        titleKey: "guides.tours.chatPower.steps.plusMenu.title",
        bodyKey: "guides.tours.chatPower.steps.plusMenu.body",
        placement: "top",
        seed: { kind: "none" },
        interaction: { kind: "open" },
      },
      {
        anchor: GUIDE_ANCHORS.chatMenuModels,
        titleKey: "guides.tours.chatPower.steps.models.title",
        bodyKey: "guides.tours.chatPower.steps.models.body",
        placement: "right",
        seed: { kind: "none" },
      },
      {
        anchor: GUIDE_ANCHORS.chatMenuSkills,
        titleKey: "guides.tours.chatPower.steps.skills.title",
        bodyKey: "guides.tours.chatPower.steps.skills.body",
        whenKey: "guides.tours.chatPower.steps.skills.when",
        placement: "right",
        seed: { kind: "none" },
      },
      {
        anchor: GUIDE_ANCHORS.chatMenuMcp,
        titleKey: "guides.tours.chatPower.steps.mcp.title",
        bodyKey: "guides.tours.chatPower.steps.mcp.body",
        whenKey: "guides.tours.chatPower.steps.mcp.when",
        placement: "right",
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
        route: { type: "workspace-unfiltered-table" },
        titleKey: "guides.tours.documents.steps.upload.title",
        bodyKey: "guides.tours.documents.steps.upload.body",
        whenKey: "guides.tours.documents.steps.upload.when",
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
    estMinutes: 4,
    steps: [
      {
        anchor: GUIDE_ANCHORS.playbooksOverview,
        route: { type: "static", to: "/knowledge/playbooks" },
        titleKey: "guides.tours.playbooks.steps.overview.title",
        bodyKey: "guides.tours.playbooks.steps.overview.body",
        placement: "right",
        seed: { kind: "none" },
      },
      {
        anchor: GUIDE_ANCHORS.playbooksCreate,
        titleKey: "guides.tours.playbooks.steps.create.title",
        bodyKey: "guides.tours.playbooks.steps.create.body",
        placement: "bottom",
        seed: { kind: "none" },
        interaction: {
          kind: "transition",
          reverseAnchor: GUIDE_ANCHORS.playbooksBack,
        },
      },
      {
        anchor: GUIDE_ANCHORS.playbooksBasics,
        titleKey: "guides.tours.playbooks.steps.basics.title",
        bodyKey: "guides.tours.playbooks.steps.basics.body",
        placement: "right",
        seed: { kind: "none" },
      },
      {
        anchor: GUIDE_ANCHORS.playbooksAddPosition,
        titleKey: "guides.tours.playbooks.steps.positions.title",
        bodyKey: "guides.tours.playbooks.steps.positions.body",
        placement: "left",
        seed: { kind: "none" },
      },
    ],
  },
  {
    id: GUIDE_TOUR_IDS.workflows,
    titleKey: "guides.tours.workflows.title",
    descriptionKey: "guides.tours.workflows.description",
    estMinutes: 5,
    steps: [
      {
        anchor: GUIDE_ANCHORS.workflowsOverview,
        route: { type: "static", to: "/knowledge/workflows" },
        titleKey: "guides.tours.workflows.steps.overview.title",
        bodyKey: "guides.tours.workflows.steps.overview.body",
        whenKey: "guides.tours.workflows.steps.overview.when",
        placement: "right",
        seed: { kind: "none" },
      },
      {
        anchor: GUIDE_ANCHORS.workflowsCreate,
        titleKey: "guides.tours.workflows.steps.create.title",
        bodyKey: "guides.tours.workflows.steps.create.body",
        placement: "bottom",
        seed: { kind: "none" },
        interaction: {
          kind: "transition",
          reverseAnchor: GUIDE_ANCHORS.workflowsBack,
        },
      },
      {
        anchor: GUIDE_ANCHORS.workflowsTrigger,
        titleKey: "guides.tours.workflows.steps.trigger.title",
        bodyKey: "guides.tours.workflows.steps.trigger.body",
        whenKey: "guides.tours.workflows.steps.trigger.when",
        placement: "right",
        seed: { kind: "none" },
      },
      {
        anchor: GUIDE_ANCHORS.workflowsSteps,
        titleKey: "guides.tours.workflows.steps.steps.title",
        bodyKey: "guides.tours.workflows.steps.steps.body",
        placement: "left",
        seed: { kind: "none" },
      },
      {
        anchor: GUIDE_ANCHORS.workflowsReviewGate,
        titleKey: "guides.tours.workflows.steps.reviewGate.title",
        bodyKey: "guides.tours.workflows.steps.reviewGate.body",
        whenKey: "guides.tours.workflows.steps.reviewGate.when",
        placement: "left",
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
        anchor: GUIDE_ANCHORS.tabularReviewTable,
        route: { type: "workspace-unfiltered-table" },
        titleKey: "guides.tours.tabularReview.steps.table.title",
        bodyKey: "guides.tours.tabularReview.steps.table.body",
        whenKey: "guides.tours.tabularReview.steps.table.when",
        placement: "top",
        seed: { kind: "none" },
      },
      {
        anchor: GUIDE_ANCHORS.tabularReviewAddColumn,
        titleKey: "guides.tours.tabularReview.steps.addColumn.title",
        bodyKey: "guides.tours.tabularReview.steps.addColumn.body",
        whenKey: "guides.tours.tabularReview.steps.addColumn.when",
        placement: "left",
        seed: { kind: "none" },
        interaction: { kind: "open" },
      },
      {
        anchor: GUIDE_ANCHORS.tabularReviewAnswerType,
        titleKey: "guides.tours.tabularReview.steps.answerType.title",
        bodyKey: "guides.tours.tabularReview.steps.answerType.body",
        whenKey: "guides.tours.tabularReview.steps.answerType.when",
        placement: "left",
        seed: { kind: "none" },
      },
    ],
  },
] as const satisfies readonly GuideTour[];
