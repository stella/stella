// Build stamps reported by `/health` and tagged onto PostHog events.
// ECS/prod release builds pass explicit `STELLA_VERSION` and
// `STELLA_COMMIT_SHA` Docker build args. Railway's source-based builds do
// not set those, but Railway always exposes `RAILWAY_GIT_COMMIT_SHA` to the
// build, so fall back to it before defaulting to "dev" for a local
// `docker build` outside either release flow.
//
// The resolver treats "" and "dev" as absent: the Dockerfile defaults both
// build args to "dev", and an empty string (e.g. an unset CI variable
// interpolating to "") must not shadow the Railway fallback or the "dev"
// default. `||` (not `??`) is deliberate for the same reason.
export const resolveStamp = (explicit: string | undefined) => {
  if (explicit && explicit !== "dev") {
    return explicit;
  }
  return process.env["RAILWAY_GIT_COMMIT_SHA"] || explicit || "dev";
};

export const APP_VERSION = resolveStamp(process.env["STELLA_VERSION"]);
export const APP_COMMIT_SHA = resolveStamp(process.env["STELLA_COMMIT_SHA"]);
