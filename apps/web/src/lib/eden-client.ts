import { createStellaEdenClient } from "@stll/api-client";
import type { MemoriesAPI, WebAPI } from "@stll/api/eden-contract";

import {
  getApiRequestHeaders,
  waitForSimulatedApiDelay,
} from "@/lib/api-request-context";
import { browserApiBaseUrl } from "@/lib/api-url";

export type WebApiRoutes = WebAPI["~Routes"]["v1"];

const clientOptions = {
  async onRequest() {
    await waitForSimulatedApiDelay();
  },
  headers: getApiRequestHeaders,
};

const eden = createStellaEdenClient<WebAPI>(browserApiBaseUrl(), clientOptions);
const memoriesEden = createStellaEdenClient<MemoriesAPI>(
  browserApiBaseUrl(),
  clientOptions,
);

export const api = eden.v1;
export const memoriesApi = memoriesEden.v1.memories;
