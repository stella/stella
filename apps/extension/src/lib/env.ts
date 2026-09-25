/** Build-time `WXT_STELLA_ORIGINS`; parsed and validated in trusted-origin.ts. */
export const rawStellaOrigins: string | undefined = import.meta.env
  .WXT_STELLA_ORIGINS;

/**
 * WXT build mode: `production` for release builds, `development` for `wxt`
 * and `build:dev`, `e2e` for the Playwright build. Unset outside a WXT build.
 */
export const buildMode: string | undefined = import.meta.env.MODE;
