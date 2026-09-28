// Passive regression fixture for
// `forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts`.

// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts -- fixture: named environment import of bun
import { env as bunEnv } from "bun";
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

// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts -- fixture: globalThis.Bun environment
export const globalBunMode = globalThis.Bun.env.APP_MODE;

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

// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts, forbid-process-env-outside-env-ts/runtime-mode-keys -- fixture: direct read of a runtime mode key
export const rawNodeEnv = process.env.NODE_ENV;

// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts, forbid-process-env-outside-env-ts/runtime-mode-keys, typescript/dot-notation -- fixture: computed read of the local development opt-in
export const rawOptIn = process.env["STELLA_LOCAL_DEV"];

// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts -- fixture: aliased environment object
const runtimeEnv = process.env;
// oxlint-disable-next-line forbid-process-env-outside-env-ts/runtime-mode-keys -- fixture: runtime mode key read through an alias
export const aliasedNodeEnv = runtimeEnv.NODE_ENV;

// oxlint-disable-next-line forbid-process-env-outside-env-ts/runtime-mode-keys -- fixture: runtime mode key read through the imported environment
export const importedOptIn = processEnv.STELLA_LOCAL_DEV;

// oxlint-disable-next-line forbid-process-env-outside-env-ts/runtime-mode-keys -- fixture: runtime mode key read through a destructured environment
export const destructuredOptIn = destructuredEnv.STELLA_LOCAL_DEV;

// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts, forbid-process-env-outside-env-ts/runtime-mode-keys -- fixture: runtime mode key destructured from the environment
const { NODE_ENV: destructuredNodeEnv } = process.env;

const {
  // oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts, forbid-process-env-outside-env-ts/runtime-mode-keys -- fixture: runtime mode key destructured through process
  env: { STELLA_LOCAL_DEV: nestedOptIn },
} = process;

const assigned: { nodeEnv?: string | undefined } = {};
// oxlint-disable-next-line forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts, forbid-process-env-outside-env-ts/runtime-mode-keys -- fixture: runtime mode key read by assignment destructuring
({ NODE_ENV: assigned.nodeEnv } = process.env);

// expect-clean: forbid-process-env-outside-env-ts/runtime-mode-keys
export const childEnvironment = { NODE_ENV: "test", STELLA_LOCAL_DEV: "1" };

const settings = { NODE_ENV: "test" };
// expect-clean: forbid-process-env-outside-env-ts/runtime-mode-keys
export const settingsNodeEnv = settings.NODE_ENV;

void processEnv;
void bunEnv;
void destructuredEnv;
void destructuredNodeEnv;
void nestedOptIn;
void assigned;
