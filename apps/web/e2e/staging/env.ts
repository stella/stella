export const getStagingReporterEnvironment = () => ({
  state: process.env["STAGING_STATE"],
  summary: process.env["GITHUB_STEP_SUMMARY"],
});
