// Vendored from ultracite 7.12.0 (MIT).
import type { OxlintConfig, OxlintEnv } from "oxlint";

// oxlint.config.ts re-applies `env` at the root.
declare const config: OxlintConfig & { env: OxlintEnv };

export default config;
