import { panic } from "better-result";
import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";

const activeFiles = new Set<string>();

type TestStateOptions<Config extends object> = {
  file: string;
  config: Config;
};

// Call in the test file's registration scope: hooks registered at module
// import time belong to the importing file only once, not to every consumer.
export const createTestState = <Config extends object>({
  file,
  config,
}: TestStateOptions<Config>) => {
  if (activeFiles.has(file)) {
    panic(`Register one test state fixture per file: ${file}`);
  }
  if (Bun.argv.includes("--concurrent")) {
    panic("Test state fixtures require serial tests");
  }
  activeFiles.add(file);
  const fileRestores = new Map<PropertyKey, () => void>();
  const testRestores = new Map<PropertyKey, () => void>();
  const suiteRestores = new Set<Map<PropertyKey, () => void>>();
  let phase:
    | { type: "file" }
    | { type: "test" }
    | { type: "suite"; restores: Map<PropertyKey, () => void> }
    | { type: "closed" } = { type: "file" };

  const closedMessage = `Test state fixture for ${file} is closed. Move the mutation into a test/beforeEach.`;
  const assertOpen = () => {
    if (phase.type === "closed") {
      panic(closedMessage);
    }
  };

  const capture = (key: PropertyKey, restore: () => void) => {
    const restores = (() => {
      switch (phase.type) {
        case "file":
          return fileRestores;
        case "test":
          return testRestores;
        case "suite":
          return phase.restores;
        case "closed":
          break;
      }
      return panic(closedMessage);
    })();
    if (!restores.has(key)) {
      restores.set(key, restore);
    }
  };
  const restore = (restores: Map<PropertyKey, () => void>) => {
    for (const undo of Array.from(restores.values()).toReversed()) {
      undo();
    }
    restores.clear();
  };
  const captureEnv = (key: string) => {
    const value = process.env[key];
    capture(`env:${key}`, () => {
      if (value === undefined) {
        if (!Reflect.deleteProperty(process.env, key)) {
          panic(`Could not restore test environment key ${key}`);
        }
      } else {
        process.env[key] = value;
      }
    });
  };
  const captureConfig = (key: PropertyKey) => {
    const descriptor = Object.getOwnPropertyDescriptor(config, key);
    capture(typeof key === "symbol" ? key : `config:${String(key)}`, () => {
      const restored =
        descriptor === undefined
          ? Reflect.deleteProperty(config, key)
          : Reflect.defineProperty(config, key, descriptor);
      if (!restored) {
        panic(`Could not restore test configuration key ${String(key)}`);
      }
    });
  };
  const setEnv = (key: string, value: string) => {
    captureEnv(key);
    process.env[key] = value;
  };

  beforeEach(() => {
    // A later teardown hook can write after our afterEach has already run.
    restore(testRestores);
    phase = { type: "test" };
  });
  afterEach(() => {
    restore(testRestores);
  });
  afterAll(() => {
    phase = { type: "closed" };
    restore(testRestores);
    for (const restores of Array.from(suiteRestores).toReversed()) {
      restore(restores);
    }
    suiteRestores.clear();
    restore(fileRestores);
    activeFiles.delete(file);
  });

  return {
    beforeAll: (setup: () => void | Promise<void>) => {
      assertOpen();
      const restores = new Map<PropertyKey, () => void>();
      beforeAll(async () => {
        assertOpen();
        restore(testRestores);
        suiteRestores.add(restores);
        phase = { type: "suite", restores };
        try {
          await setup();
        } finally {
          phase = { type: "test" };
        }
      });
      afterAll(() => {
        if (phase.type === "closed" || !suiteRestores.has(restores)) {
          return;
        }
        restore(testRestores);
        // Several setup hooks in one suite must unwind in reverse write order.
        for (const active of Array.from(suiteRestores).toReversed()) {
          restore(active);
          suiteRestores.delete(active);
          if (active === restores) {
            break;
          }
        }
      });
    },
    setEnv,
    setEnvIfAbsent: (key: string, value: string) => {
      assertOpen();
      if (process.env[key] === undefined) {
        setEnv(key, value);
      }
    },
    deleteEnv: (key: string) => {
      captureEnv(key);
      if (!Reflect.deleteProperty(process.env, key)) {
        panic(`Could not delete test environment key ${key}`);
      }
    },
    setConfig: <Key extends keyof Config>(key: Key, value: Config[Key]) => {
      captureConfig(key);
      config[key] = value;
    },
    deleteConfig: (key: keyof Config) => {
      captureConfig(key);
      if (!Reflect.deleteProperty(config, key)) {
        panic(`Could not delete test configuration key ${String(key)}`);
      }
    },
    patchConfig: (values: Partial<Config>) => {
      assertOpen();
      for (const key of Reflect.ownKeys(values)) {
        captureConfig(key);
        if (!Reflect.set(config, key, Reflect.get(values, key))) {
          panic(`Could not set test configuration key ${String(key)}`);
        }
      }
    },
  };
};
