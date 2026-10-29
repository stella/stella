import { routes } from "@/api/http/route";

import transcribe from "./transcribe";

export const dictationRoute = routes(
  { "/transcribe": { POST: transcribe } },
  { prefix: "/dictation" },
);
