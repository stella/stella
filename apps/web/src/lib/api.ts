import { treaty } from "@elysiajs/eden";
import { createClient, createRivetKitWithClient } from "@rivetkit/react";
import type { ExtractActorsFromRegistry } from "rivetkit/client";

import type { API, Registry } from "@stella/api/types";

import { env } from "@/env";

const eden = treaty<API>(env.VITE_API_URL, {
  fetch: {
    credentials: "include",
  },
});

export const api = eden.v1;

export const rivet = createClient<Registry>({
  endpoint: env.VITE_RIVET_ENDPOINT,
});

type Actors = ExtractActorsFromRegistry<Registry>;
export type ChatActor = Actors["chat"];

export const { useActor } = createRivetKitWithClient(rivet);
