import { CHAT_TURN_ID_HEADER } from "@stll/api-contract";
import { CLAUSE_WARNINGS_HEADER } from "@stll/api-contract/template-fill-headers";

import { REQUEST_ID_HEADER } from "./observability/request-context";

export const CORS_EXPOSED_HEADERS = [
  "Content-Disposition",
  "X-Ai-Field-Errors",
  CLAUSE_WARNINGS_HEADER,
  REQUEST_ID_HEADER,
  CHAT_TURN_ID_HEADER,
];
