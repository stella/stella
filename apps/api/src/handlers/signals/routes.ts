import acceptSignal from "@/api/handlers/signals/acceptances/create";
import assignSignal from "@/api/handlers/signals/assignments/create";
import countInbox from "@/api/handlers/signals/count";
import dismissSignal from "@/api/handlers/signals/dismissals/create";
import getSignal from "@/api/handlers/signals/get";
import listSignals from "@/api/handlers/signals/list";
import createRequest from "@/api/handlers/signals/requests/create";
import snoozeSignal from "@/api/handlers/signals/snoozes/create";
import { routes } from "@/api/http/route";

export const signalsRoute = routes(
  {
    "/": { GET: listSignals },
    "/count": { GET: countInbox },
    "/requests": { POST: createRequest },
    "/:signalId": { GET: getSignal },
    "/:signalId/snoozes": { POST: snoozeSignal },
    "/:signalId/dismissals": { POST: dismissSignal },
    "/:signalId/assignments": { POST: assignSignal },
    "/:signalId/acceptances": { POST: acceptSignal },
  },
  { prefix: "/signals" },
);
