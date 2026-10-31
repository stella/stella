import { expectTypeOf } from "bun:test";

import {
  BUSINESS_REGISTRY_DISPATCH,
  type RegistryHandler,
} from "@/api/lib/business-registries/dispatch";

expectTypeOf(BUSINESS_REGISTRY_DISPATCH.ares).toExtend<
  RegistryHandler<"ares">
>();
expectTypeOf(BUSINESS_REGISTRY_DISPATCH.krs).toExtend<RegistryHandler<"krs">>();

const nativeSearch = BUSINESS_REGISTRY_DISPATCH.ares.search;

const unsupportedWithNameSearch: RegistryHandler<"vies"> = {
  ...BUSINESS_REGISTRY_DISPATCH.vies,
  // @ts-expect-error VIES declares name search as unsupported.
  search: nativeSearch,
};

const nativeWithoutNameSearch: RegistryHandler<"ares"> = {
  ...BUSINESS_REGISTRY_DISPATCH.ares,
  // @ts-expect-error ARES declares native name search, so it cannot omit it.
  search: null,
};

expectTypeOf(unsupportedWithNameSearch).toExtend<RegistryHandler>();
expectTypeOf(nativeWithoutNameSearch).toExtend<RegistryHandler>();
