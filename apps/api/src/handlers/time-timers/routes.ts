import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import adminList from "./admin/list";
import adminStop from "./admin/stop";
import confirm from "./confirm";
import discard from "./discard";
import list from "./list";
import pause from "./pause";
import resume from "./resume";
import start from "./start";
import update from "./update";

export const timeTimersRoute = routes(
  {
    "/": { GET: list },
    "/admin": { GET: adminList },
    "/admin/:id/stop": { POST: adminStop },
    "/start": { POST: start },
    "/:id/pause": { POST: pause },
    "/:id/resume": { POST: resume },
    "/:id": { PATCH: update, DELETE: discard },
    "/:id/confirm": { POST: confirm },
  },
  {
    prefix: "/v1/time-timers",
    middleware: [
      deploymentFeatureGate("FEATURE_TIME_BILLING"),
      featureAccessGate("time-billing"),
      rateLimit(createStandardApiRateLimitOptions()),
    ],
  },
);
