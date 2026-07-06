// The API version reported by `/health` and tagged onto PostHog events.
// ECS/prod release builds pass an explicit `STELLA_VERSION` Docker build arg.
// Railway's source-based builds do not set that, but Railway always exposes
// `RAILWAY_GIT_COMMIT_SHA` to the build, so fall back to it before defaulting
// to "dev" for a local `docker build` outside either release flow.
const resolveAppVersion = () => {
  const explicitVersion = process.env["STELLA_VERSION"];
  if (explicitVersion && explicitVersion !== "dev") {
    return explicitVersion;
  }
  return process.env["RAILWAY_GIT_COMMIT_SHA"] ?? explicitVersion ?? "dev";
};

export const APP_VERSION = resolveAppVersion();
