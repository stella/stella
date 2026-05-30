// Typed clients for national business / commercial registries.
//
// Each registry lives in its own subpath so consumers can import only what
// they need and tree-shake the rest:
//
//   import { lookupByIco } from "@stll/business-registries/ares";
//
// The root entry re-exports each registry under a namespace for convenience:
//
//   import { ares } from "@stll/business-registries";
//   await ares.lookupByIco("27082440");
export * as ares from "./ares/index.js";
