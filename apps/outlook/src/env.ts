const DEV_DEFAULTS = {
  apiBaseUrl: "/api",
  stellaWebUrl: "http://localhost:3000",
  taskpaneOrigin: "https://localhost:3002",
} as const;

const PROD_DEFAULTS = {
  apiBaseUrl: "https://api.stll.app",
  stellaWebUrl: "https://my.stll.app",
  taskpaneOrigin: "https://outlook.stll.app",
} as const;

const readBuildEnv = (): "dev" | "prod" => {
  const value: unknown = Reflect.get(globalThis, "STELLA_BUILD_ENV");
  return value === "prod" ? "prod" : "dev";
};

const STELLA_BUILD_ENV = readBuildEnv();

const defaults = STELLA_BUILD_ENV === "prod" ? PROD_DEFAULTS : DEV_DEFAULTS;

export const env = {
  apiBaseUrl: defaults.apiBaseUrl,
  signInOrigin: defaults.stellaWebUrl,
  stellaWebUrl: defaults.stellaWebUrl,
  taskpaneOrigin: defaults.taskpaneOrigin,
};
