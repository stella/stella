import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  BUILD_KIND,
  currentBuildKind,
  LOCAL_DEV_OPT_IN,
  NODE_ENV,
  RUNTIME_MODE,
  resolveRuntimeMode,
} from "./index";

const NODE_ENV_INPUTS = [undefined, "", ...Object.values(NODE_ENV)] as const;
const OPT_IN_INPUTS = [undefined, "", LOCAL_DEV_OPT_IN.value] as const;
const BUILD_KINDS = Object.values(BUILD_KIND);

const LOCAL_NODE_ENVS: ReadonlySet<string | undefined> = new Set([
  NODE_ENV.development,
  NODE_ENV.test,
]);

describe("runtime mode resolution", () => {
  test("opens only for a local NODE_ENV with the opt-in in a source build", () => {
    for (const nodeEnv of NODE_ENV_INPUTS) {
      for (const localDevOptIn of OPT_IN_INPUTS) {
        for (const buildKind of BUILD_KINDS) {
          const resolved = resolveRuntimeMode({
            nodeEnv,
            localDevOptIn,
            buildKind,
          });
          const optedIn = localDevOptIn === LOCAL_DEV_OPT_IN.value;
          const honoured =
            LOCAL_NODE_ENVS.has(nodeEnv) && buildKind === BUILD_KIND.source;
          const context = JSON.stringify({ nodeEnv, localDevOptIn, buildKind });

          if (!optedIn) {
            expect(
              Result.isOk(resolved) && resolved.value.runtimeMode.mode,
              context,
            ).toBe(RUNTIME_MODE.strict);
            continue;
          }
          if (honoured) {
            expect(
              Result.isOk(resolved) && resolved.value.runtimeMode.mode,
              context,
            ).toBe(RUNTIME_MODE.open);
            continue;
          }
          expect(Result.isError(resolved), context).toBe(true);
        }
      }
    }
  });

  test("refuses the opt-in outside a local NODE_ENV", () => {
    for (const nodeEnv of [undefined, NODE_ENV.staging, NODE_ENV.production]) {
      const resolved = resolveRuntimeMode({
        nodeEnv,
        localDevOptIn: LOCAL_DEV_OPT_IN.value,
        buildKind: BUILD_KIND.source,
      });

      expect(Result.isError(resolved) && resolved.error.message).toContain(
        "requires NODE_ENV=development or test",
      );
    }
  });

  test("refuses the opt-in in a release build", () => {
    const resolved = resolveRuntimeMode({
      nodeEnv: NODE_ENV.development,
      localDevOptIn: LOCAL_DEV_OPT_IN.value,
      buildKind: BUILD_KIND.release,
    });

    expect(Result.isError(resolved) && resolved.error.message).toBe(
      "STELLA_LOCAL_DEV is not available in a release build.",
    );
  });

  test("refuses an opt-in value other than 1", () => {
    for (const localDevOptIn of ["true", "yes", "0", " 1"]) {
      const resolved = resolveRuntimeMode({
        nodeEnv: NODE_ENV.development,
        localDevOptIn,
        buildKind: BUILD_KIND.source,
      });

      expect(Result.isError(resolved) && resolved.error.message).toBe(
        'STELLA_LOCAL_DEV accepts only "1".',
      );
    }
  });

  test("refuses an unknown NODE_ENV with or without the opt-in", () => {
    for (const localDevOptIn of OPT_IN_INPUTS) {
      const resolved = resolveRuntimeMode({
        nodeEnv: "prod",
        localDevOptIn,
        buildKind: BUILD_KIND.source,
      });

      expect(Result.isError(resolved) && resolved.error.message).toContain(
        'NODE_ENV="prod" is not a recognized environment.',
      );
    }
  });

  test("reads a source run as a source build", () => {
    expect(currentBuildKind()).toBe(BUILD_KIND.source);
  });

  test("flags a test run only when local development access is open", () => {
    for (const nodeEnv of NODE_ENV_INPUTS) {
      for (const localDevOptIn of OPT_IN_INPUTS) {
        for (const buildKind of BUILD_KINDS) {
          const resolved = resolveRuntimeMode({
            nodeEnv,
            localDevOptIn,
            buildKind,
          });
          if (Result.isError(resolved)) {
            continue;
          }
          expect(
            resolved.value.isLocalTestRun,
            JSON.stringify({ nodeEnv, localDevOptIn, buildKind }),
          ).toBe(
            resolved.value.runtimeMode.mode === RUNTIME_MODE.open &&
              nodeEnv === NODE_ENV.test,
          );
        }
      }
    }
  });

  test("labels NODE_ENV without opening a strict test process", () => {
    const unset = resolveRuntimeMode({
      nodeEnv: "",
      localDevOptIn: undefined,
      buildKind: BUILD_KIND.source,
    });
    const testProcess = resolveRuntimeMode({
      nodeEnv: NODE_ENV.test,
      localDevOptIn: undefined,
      buildKind: BUILD_KIND.source,
    });

    expect(Result.isOk(unset) && unset.value).toEqual({
      runtimeMode: { mode: RUNTIME_MODE.strict },
      nodeEnv: "unset",
      isLocalTestRun: false,
    });
    expect(Result.isOk(testProcess) && testProcess.value).toEqual({
      runtimeMode: { mode: RUNTIME_MODE.strict },
      nodeEnv: NODE_ENV.test,
      isLocalTestRun: false,
    });
  });
});
