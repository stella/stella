import { treaty } from "@elysiajs/eden";
import { createClient, createRivetKitWithClient } from "@rivetkit/react";
import { posthog } from "posthog-js";
import type { ExtractActorsFromRegistry } from "rivetkit/client";

import type { API, Registry } from "@stella/api/types";

import { env } from "@/env";

const eden = treaty<API>(env.VITE_API_URL, {
  fetch: {
    credentials: "include",
  },
  headers() {
    const sessionId = posthog.get_session_id();
    return sessionId ? { "x-posthog-session-id": sessionId } : {};
  },
});

export const api = eden.v1;

export const rivet = createClient<Registry>({
  endpoint: env.VITE_RIVET_ENDPOINT,
});

export type Actors = ExtractActorsFromRegistry<Registry>;
export type ChatActor = Actors["chat"];

export const { useActor } = createRivetKitWithClient(rivet);
