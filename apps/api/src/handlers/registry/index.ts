import { setup } from "rivetkit";
import { createClient } from "rivetkit/client";
import type { ExtractActorsFromRegistry } from "rivetkit/client";

import { bBoxActor } from "@/api/handlers/registry/actors/b-box/actor";
import { chatActor } from "@/api/handlers/registry/actors/chat-actor";
import { syncActor } from "@/api/handlers/registry/actors/sync-actor";
import { viewsActor } from "@/api/handlers/registry/actors/views/actor";
import { workflowActor } from "@/api/handlers/registry/actors/workflow/actor";

export const registry = setup({
  use: {
    workflow: workflowActor,
    sync: syncActor,
    bBox: bBoxActor,
    chat: chatActor,
    views: viewsActor,
  },
  // Required since 2.1.6: the manager no longer auto-starts
  // unless explicitly opted in (Cloudflare Workers compat).
  serveManager: true,
});

export type Registry = typeof registry;

type AllRegistryActors = ExtractActorsFromRegistry<Registry>;

export type ActorsUnion = AllRegistryActors[keyof AllRegistryActors];

export const rivet = createClient<typeof registry>();
