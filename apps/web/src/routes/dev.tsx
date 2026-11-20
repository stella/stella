import { createFileRoute } from "@tanstack/react-router";

import {
  APP_FRAME_SCOPE,
  MEMBER_PROVIDER_SCOPES,
} from "@/routes/-app-frame-scope";

import { DevPage } from "./dev/-dev.page";
import { DevPending } from "./dev/-dev.pending";
import { visualSearchSchema } from "./dev/-visual-search";

export const Route = createFileRoute("/dev")({
  staticData: {
    appFrame: APP_FRAME_SCOPE.none,
    // Playground fixtures host their own auth, AI and composer providers.
    providerScopes: MEMBER_PROVIDER_SCOPES,
  },
  validateSearch: visualSearchSchema,
  component: DevPage,
  pendingComponent: DevPending,
});
