import { panic } from "better-result";
import { afterAll } from "bun:test";

type WebTestEnvironmentOptions = { file: string };

/** File-owned environment setup for web tests that import the validated env module. */
export const createWebTestEnvironment = ({
  file,
}: WebTestEnvironmentOptions) => {
  const initialized = new Set<string>();
  let lifecycle: "open" | "closed" = "open";
  afterAll(() => {
    lifecycle = "closed";
    for (const key of initialized) {
      if (!Reflect.deleteProperty(process.env, key)) {
        panic(`Could not restore test environment key ${key}`);
      }
    }
    initialized.clear();
  });
  return {
    setEnvIfAbsent: (key: string, value: string) => {
      if (lifecycle === "closed") {
        panic(`Test environment for ${file} is closed`);
      }
      if (process.env[key] !== undefined) {
        return;
      }
      initialized.add(key);
      process.env[key] = value;
    },
  };
};
