import createDocumentReviewRun from "@/api/handlers/document-reviews/create-run";
import decideDocumentReviewFinding from "@/api/handlers/document-reviews/decide-finding";
import exportDocumentReviewRun from "@/api/handlers/document-reviews/export-run";
import listDocumentReviewRuns from "@/api/handlers/document-reviews/list-runs";
import listDocumentReviewSources from "@/api/handlers/document-reviews/list-sources";
import reviewParties from "@/api/handlers/document-reviews/parties";
import proposePositions from "@/api/handlers/document-reviews/propose-positions";
import proposePositionsStream from "@/api/handlers/document-reviews/propose-positions-stream";
import readDocumentReviewRun from "@/api/handlers/document-reviews/read-run";
import { routes } from "@/api/http/route";

export const documentReviewsRoute = routes(
  {
    "/sources": { GET: listDocumentReviewSources },
    "/positions": { POST: proposePositions },
    "/positions/stream": { POST: proposePositionsStream },
    "/parties": { POST: reviewParties },
    "/runs": { POST: createDocumentReviewRun, GET: listDocumentReviewRuns },
    "/runs/:runId": { GET: readDocumentReviewRun },
    "/runs/:runId/export": { GET: exportDocumentReviewRun },
    "/findings/:findingId": { PATCH: decideDocumentReviewFinding },
  },
  { prefix: "/workspaces/:workspaceId/document-reviews" },
);
