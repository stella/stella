// Passive regression fixture for
// `forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts`.

declare const env: { APP_MODE: string };

// MUST flag: direct dot access bypasses the validated env module.
// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts -- fixture: direct environment reads must be rejected
export const rawMode = process.env.APP_MODE;

// MUST flag: bracket notation is the same unvalidated boundary.
// eslint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts, typescript/dot-notation -- fixture: bracket environment reads must be rejected
export const rawSecret = process.env["SERVICE_SECRET"];

// MUST flag: passing the entire ambient environment also bypasses validation.
export const rawEnvironment = {
  // oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts -- fixture: the whole process.env object is unvalidated
  env: process.env,
};

// Allowed: application code consumes the validated env module.
export const validatedMode = env.APP_MODE;

// Allowed: unrelated process properties are not environment reads.
export const runtimeVersion = process.version;
