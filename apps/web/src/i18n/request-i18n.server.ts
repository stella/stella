import { AsyncLocalStorage } from "node:async_hooks";
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";

import type { I18nState } from "@/i18n/i18n-store";

type RequestI18n = { store?: StoreApi<I18nState> };

// Created on first server use: browser bundles that keep this module without
// the Start compiler must still evaluate it.
let requestI18n: AsyncLocalStorage<RequestI18n> | undefined;
const requestStorage = () =>
  (requestI18n ??= new AsyncLocalStorage<RequestI18n>());

export const withRequestI18n = <T>(render: () => T): T =>
  requestStorage().run({}, render);

export const initializeRequestI18n = (state: I18nState) => {
  const request = requestStorage().getStore();
  if (request) {
    request.store = createStore(() => state);
  }
};

export const getRequestI18nStore = () => requestStorage().getStore()?.store;
