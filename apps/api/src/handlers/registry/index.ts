import { setup } from "rivetkit";
import { createClient } from "rivetkit/client";
import type { ExtractActorsFromRegistry } from "rivetkit/client";

import { bBoxActor } from "@/api/handlers/registry/actors/b-box/actor";
import { chatActor } from "@/api/handlers/registry/actors/chat-actor";
import { syncActor } from "@/api/handlers/registry/actors/sync-actor";
import { viewsActor } from "@/api/handlers/registry/actors/views/actor";
import { workflowActor } from "@/api/handlers/registry/actors/workflow/actor";

/**
 * RivetKit manager runs on port 6420 at root path.
 *
 * RivetKit auto-generates `clientEndpoint` from the manager
 * port in dev mode, but does NOT include `managerBasePath`.
 * This means clients would try to connect WebSockets to
 * `http://127.0.0.1:6420/actors/...` instead of
 * `http://127.0.0.1:6420/api/rivet/actors/...`.
 *
 * To avoid this mismatch, we run without a basePath. The ALB
 * in production strips the `/api/rivet` prefix when proxying
 * to port 6420.
 *
 * Frontend connects to `http://localhost:6420` (dev) or
 * the ALB-proxied path (prod) via VITE_RIVET_ENDPOINT.
 */
export const registry = setup({
  use: {
    workflow: workflowActor,
    sync: syncActor,
    bBox: bBoxActor,
    chat: chatActor,
    views: viewsActor,
  },
  serveManager: true,
});

export type Registry = typeof registry;

type AllRegistryActors = ExtractActorsFromRegistry<Registry>;

export type ActorsUnion = AllRegistryActors[keyof AllRegistryActors];

export const rivet = createClient<typeof registry>({
  endpoint: "http://127.0.0.1:6420",
});
