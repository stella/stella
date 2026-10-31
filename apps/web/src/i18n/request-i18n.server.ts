import { AsyncLocalStorage } from "node:async_hooks";
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";

import type { I18nState } from "@/i18n/i18n-store";

const requestI18n = new AsyncLocalStorage<{ store?: StoreApi<I18nState> }>();

export const withRequestI18n = <T>(render: () => T): T =>
  requestI18n.run({}, render);

export const initializeRequestI18n = (state: I18nState) => {
  const request = requestI18n.getStore();
  if (request) {
    request.store = createStore(() => state);
  }
};

export const getRequestI18nStore = () => requestI18n.getStore()?.store;
