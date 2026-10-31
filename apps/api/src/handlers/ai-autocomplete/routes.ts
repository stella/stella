import autocompleteStream from "@/api/handlers/ai-autocomplete/stream";
import { routes } from "@/api/http/route";
import { localDevelopmentGate } from "@/api/lib/deployment-feature-route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

// Local development only: elsewhere the route answers like an absent one.
export const aiAutocompleteRoute = routes(
  { "/stream": { POST: autocompleteStream } },
  {
    prefix: "/v1/ai-autocomplete",
    middleware: [
      rateLimit(createStandardApiRateLimitOptions()),
      localDevelopmentGate,
    ],
  },
);
