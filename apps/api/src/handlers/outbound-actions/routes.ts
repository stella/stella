import confirmOutboundAction from "@/api/handlers/outbound-actions/confirm";
import discardOutboundAction from "@/api/handlers/outbound-actions/discard";
import readOutboundAction from "@/api/handlers/outbound-actions/read";
import { routes } from "@/api/http/route";

export const outboundActionsRoute = routes(
  {
    "/:actionId": { GET: readOutboundAction },
    "/:actionId/confirm": { POST: confirmOutboundAction },
    "/:actionId/discard": { POST: discardOutboundAction },
  },
  { prefix: "/outbound-actions" },
);
