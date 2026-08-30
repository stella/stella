import {
  GUIDE_TOUR_IDS,
  type GuideTourId,
} from "@/features/guides/guide-types";

type GuideAvailability = {
  canUseChat: boolean;
  canCreateDocument: boolean;
  canCreateProperty: boolean;
  documentsAvailable: boolean;
  tabularReviewAvailable: boolean;
  playbooksAvailable: boolean;
  workflowsAvailable: boolean;
  canCreatePlaybook: boolean;
  canCreateWorkflow: boolean;
};

export const isGuideTourAvailable = (
  tourId: GuideTourId,
  availability: GuideAvailability,
): boolean => {
  switch (tourId) {
    case GUIDE_TOUR_IDS.chat:
      return availability.canUseChat;
    case GUIDE_TOUR_IDS.documents:
      return availability.canCreateDocument && availability.documentsAvailable;
    case GUIDE_TOUR_IDS.tabularReview:
      return (
        availability.canCreateProperty && availability.tabularReviewAvailable
      );
    case GUIDE_TOUR_IDS.playbooks:
      return availability.playbooksAvailable && availability.canCreatePlaybook;
    case GUIDE_TOUR_IDS.workflows:
      return availability.workflowsAvailable && availability.canCreateWorkflow;
    default:
      tourId satisfies never;
      return false;
  }
};
