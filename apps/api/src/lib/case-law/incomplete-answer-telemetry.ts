import type { CaseLawIncompleteAnswerEvent } from "@stll/api-contract/case-law-answer-completeness";

import { logger } from "@/api/lib/observability/logger";

export const reportCaseLawIncompleteAnswer = (
  event: CaseLawIncompleteAnswerEvent,
): void => {
  if (event.count === 0) {
    return;
  }
  logger.info("case_law.answer.incomplete", event);
};
