import createReaderAnswer from "@/api/handlers/legal-reader/answers/create";
import deleteReaderAnswer from "@/api/handlers/legal-reader/answers/delete";
import followUpReaderAnswer from "@/api/handlers/legal-reader/answers/follow-up";
import listReaderAnswers from "@/api/handlers/legal-reader/answers/list";
import regenerateReaderAnswer from "@/api/handlers/legal-reader/answers/regenerate";
import updateReaderAnswer from "@/api/handlers/legal-reader/answers/update";
import { routes } from "@/api/http/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

// Member routes declare no cache policy, so every answer is private, no-store.
export const readerAnswersRoute = routes(
  {
    "/": { GET: listReaderAnswers, POST: createReaderAnswer },
    "/:answerId/messages": { POST: followUpReaderAnswer },
    "/:answerId/regenerate": { POST: regenerateReaderAnswer },
    "/:answerId": { PATCH: updateReaderAnswer, DELETE: deleteReaderAnswer },
  },
  {
    prefix: "/answers",
    middleware: [deploymentFeatureGate("FEATURE_PUBLIC_LAW")],
  },
);
