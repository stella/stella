import { createStellaEdenClient } from "@stll/api-client";
import type { MemoriesAPI, WebAPI } from "@stll/api/types";

import { env } from "@/env";
import {
  getApiRequestHeaders,
  waitForSimulatedApiDelay,
} from "@/lib/api-request-context";

const clientOptions = {
  async onRequest() {
    await waitForSimulatedApiDelay();
  },
  headers: getApiRequestHeaders,
};

const eden = createStellaEdenClient<WebAPI>(env.VITE_API_URL, clientOptions);
const memoriesEden = createStellaEdenClient<MemoriesAPI>(
  env.VITE_API_URL,
  clientOptions,
);

export const api = eden.v1;
export const memoriesApi = memoriesEden.v1.memories;
