import { setup } from "rivetkit";
import { createClient } from "rivetkit/client";
import type { ExtractActorsFromRegistry } from "rivetkit/client";

import { bBoxActor } from "@/api/handlers/registry/actors/b-box/actor";
import { chatActor } from "@/api/handlers/registry/actors/chat-actor";
import { syncActor } from "@/api/handlers/registry/actors/sync-actor";
import { viewsActor } from "@/api/handlers/registry/actors/views/actor";
import { workflowActor } from "@/api/handlers/registry/actors/workflow/actor";

/**
 * Base path for the RivetKit manager router. Consistent across
 * dev and production for parity. In production, ALB routes
 * /api/rivet/* to port 6420. In dev, the frontend connects
 * directly to localhost:6420/api/rivet.
 */
const RIVET_BASE_PATH = "/api/rivet";

export const registry = setup({
  use: {
    workflow: workflowActor,
    sync: syncActor,
    bBox: bBoxActor,
    chat: chatActor,
    views: viewsActor,
  },
  serveManager: true,
  managerBasePath: RIVET_BASE_PATH,
});

export type Registry = typeof registry;

type AllRegistryActors = ExtractActorsFromRegistry<Registry>;

export type ActorsUnion = AllRegistryActors[keyof AllRegistryActors];

export const rivet = createClient<typeof registry>({
  endpoint: `http://127.0.0.1:6420${RIVET_BASE_PATH}`,
});
