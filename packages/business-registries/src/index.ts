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
export * as brreg from "./brreg/index.js";
export * as edgar from "./edgar/index.js";
export * as gcis from "./gcis/index.js";
export * as krs from "./krs/index.js";
export * as orsr from "./orsr/index.js";
export * as prh from "./prh/index.js";
export * as rechercheEntreprises from "./recherche-entreprises/index.js";
export * as shared from "./shared/index.js";
export * as vies from "./vies/index.js";
