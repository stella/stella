// Passive regression fixture for
// `forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts`.

// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts -- fixture: aliased named import of the environment object
import nodeProcess, { env as processEnv } from "node:process";
import * as processNamespace from "node:process";

declare const env: { APP_MODE: string };

// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts -- fixture: direct environment read
export const rawMode = process.env.APP_MODE;

// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts, typescript/dot-notation -- fixture: computed member of the environment object
export const rawSecret = process.env["SERVICE_SECRET"];

export const rawEnvironment = {
  // oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts -- fixture: the whole environment object
  env: process.env,
};

// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts, typescript/dot-notation -- fixture: computed member of process
export const computedProcess = process["env"].APP_MODE;

// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts -- fixture: destructured from process
const { env: destructuredEnv } = process;

// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts -- fixture: globalThis member
export const globalMode = globalThis.process.env.APP_MODE;

// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts -- fixture: Bun environment
export const bunMode = Bun.env.APP_MODE;

// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts -- fixture: import.meta.env in server code
export const metaMode = import.meta.env.APP_MODE;

// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts -- fixture: default import of node:process
export const defaultImportMode = nodeProcess.env.APP_MODE;

// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts -- fixture: namespace import of node:process
export const namespaceMode = processNamespace.env.APP_MODE;

const processAlias = process;
// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts -- fixture: aliased process object
export const aliasedMode = processAlias.env.APP_MODE;

// expect-clean: forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts
export const validatedMode = env.APP_MODE;

// expect-clean: forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts
export const runtimeVersion = process.version;

void processEnv;
void destructuredEnv;
