export const playwrightEnv = {
  get ci() {
    return process.env["CI"];
  },
  get jsonOutputFile() {
    return process.env["PLAYWRIGHT_JSON_OUTPUT_FILE"];
  },
  get webUrl() {
    return process.env["E2E_WEB_URL"];
  },
  get landingUrl() {
    return process.env["E2E_LANDING_URL"];
  },
};
