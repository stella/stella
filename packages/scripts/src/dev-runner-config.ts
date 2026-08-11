import { Result, TaggedError, type TaggedErrorClass } from "better-result";

export const DEV_MODES = ["dev", "dev:web", "dev:api", "dev:desktop"] as const;
export type DevMode = (typeof DEV_MODES)[number];

export const DEFAULT_PORTS = {
  api: 3001,
  desktopBridge: 45_901,
  desktopView: 5177,
  web: 3000,
} as const;
export const DEFAULT_INFRA_PORTS = {
  gotenberg: 3003,
  postgres: 5432,
  rustfs: 9000,
  rustfsConsole: 9001,
  valkey: 6379,
} as const;
const MAX_PORT = 65_535;
export const MAX_INFRA_OFFSET =
  MAX_PORT - Math.max(...Object.values(DEFAULT_INFRA_PORTS));
export const MAX_PORT_OFFSET =
  MAX_PORT - Math.max(...Object.values(DEFAULT_PORTS));

export type DevRunnerEnvironment = Readonly<Record<string, string | undefined>>;

export type DevRunnerConfig = {
  devInstance: string | undefined;
  dryRun: boolean;
  infraOffset: number;
  mode: DevMode;
  noBrowser: boolean;
  portOffset: number | undefined;
  skipDbPush: boolean;
  skipInstall: boolean;
};

export type DevRunnerConfigInput = {
  args: readonly string[];
  environment: DevRunnerEnvironment;
};

export type DevRunnerConfigErrorCode =
  | "invalid-integer"
  | "missing-value"
  | "out-of-range"
  | "unknown-argument";

const DevRunnerConfigErrorBase: TaggedErrorClass<"DevRunnerConfigError"> =
  TaggedError("DevRunnerConfigError");

export class DevRunnerConfigError extends DevRunnerConfigErrorBase<{
  code: DevRunnerConfigErrorCode;
  message: string;
  source: string;
}> {
  constructor({
    code,
    message,
    source,
  }: {
    code: DevRunnerConfigErrorCode;
    message: string;
    source: string;
  }) {
    super({ code, message, source });
  }
}

const isDevMode = (value: string): value is DevMode =>
  DEV_MODES.some((mode) => mode === value);

const invalid = (
  code: DevRunnerConfigErrorCode,
  source: string,
  message: string,
) => Result.err(new DevRunnerConfigError({ code, message, source }));

const parseInteger = (
  value: string,
  source: string,
  maximum: number,
): Result<number, DevRunnerConfigError> => {
  if (!/^[+-]?\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    return invalid("invalid-integer", source, `${source} must be an integer`);
  }
  const parsed = Number(value);
  if (parsed < 0 || parsed > maximum) {
    return invalid(
      "out-of-range",
      source,
      `${source} must be an integer between 0 and ${String(maximum)}`,
    );
  }
  return Result.ok(parsed);
};

const parseIntegerOption = (
  value: string | undefined,
  source: string,
  maximum: number,
): Result<number | undefined, DevRunnerConfigError> => {
  if (value === undefined) {
    return Result.ok(undefined);
  }
  return parseInteger(value, source, maximum);
};

const validateDevInstance = (
  value: string | undefined,
  source: string,
): Result<string | undefined, DevRunnerConfigError> => {
  if (value === undefined || !/^\d+$/u.test(value.trim())) {
    return Result.ok(value);
  }
  const parsed = parseInteger(value.trim(), source, MAX_PORT_OFFSET);
  if (Result.isError(parsed)) {
    return Result.err(parsed.error);
  }
  return Result.ok(value);
};

const parseCliArgs = (
  args: readonly string[],
): Result<
  Omit<DevRunnerConfig, "infraOffset" | "portOffset" | "devInstance"> & {
    devInstance: string | undefined;
    infraOffset: string | undefined;
    portOffset: string | undefined;
  },
  DevRunnerConfigError
> => {
  let mode: DevMode = "dev";
  let portOffset: string | undefined;
  let infraOffset: string | undefined;
  let devInstance: string | undefined;
  let skipInstall = false;
  let skipDbPush = false;
  let dryRun = false;
  let noBrowser = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (isDevMode(arg)) {
      mode = arg;
      continue;
    }
    if (arg === "--skip-install") {
      skipInstall = true;
      continue;
    }
    if (arg === "--skip-db-push") {
      skipDbPush = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--no-browser") {
      noBrowser = true;
      continue;
    }

    let option: "devInstance" | "infraOffset" | "portOffset" | undefined;
    if (arg === "--port-offset") {
      option = "portOffset";
    } else if (arg === "--infra-offset") {
      option = "infraOffset";
    } else if (arg === "--dev-instance") {
      option = "devInstance";
    }
    if (option === undefined) {
      return invalid("unknown-argument", arg, `Unknown argument: ${arg}`);
    }
    const value = args[index + 1];
    if (!value) {
      return invalid("missing-value", arg, `${arg} requires a value`);
    }
    if (option === "portOffset") {
      portOffset = value;
    } else if (option === "infraOffset") {
      infraOffset = value;
    } else {
      devInstance = value;
    }
    index++;
  }

  return Result.ok({
    devInstance,
    dryRun,
    infraOffset,
    mode,
    noBrowser,
    portOffset,
    skipDbPush,
    skipInstall,
  });
};

export const parseDevRunnerConfig = ({
  args,
  environment,
}: DevRunnerConfigInput): Result<DevRunnerConfig, DevRunnerConfigError> => {
  const cli = parseCliArgs(args);
  if (Result.isError(cli)) {
    return cli;
  }

  const {
    devInstance: cliDevInstance,
    infraOffset: cliInfraOffset,
    portOffset: cliPortOffset,
    ...flags
  } = cli.value;
  const portOffset = parseIntegerOption(
    cliPortOffset ?? environment["STELLA_PORT_OFFSET"],
    cliPortOffset === undefined ? "STELLA_PORT_OFFSET" : "--port-offset",
    MAX_PORT_OFFSET,
  );
  if (Result.isError(portOffset)) {
    return portOffset;
  }
  const infraOffset = parseIntegerOption(
    cliInfraOffset ?? environment["STELLA_INFRA_OFFSET"] ?? "0",
    cliInfraOffset === undefined ? "STELLA_INFRA_OFFSET" : "--infra-offset",
    MAX_INFRA_OFFSET,
  );
  if (Result.isError(infraOffset)) {
    return infraOffset;
  }
  const devInstance = validateDevInstance(
    cliDevInstance ?? environment["STELLA_DEV_INSTANCE"],
    cliDevInstance === undefined
      ? "numeric STELLA_DEV_INSTANCE"
      : "--dev-instance",
  );
  if (Result.isError(devInstance)) {
    return devInstance;
  }

  return Result.ok({
    ...flags,
    devInstance: devInstance.value,
    infraOffset: infraOffset.value ?? 0,
    portOffset: portOffset.value,
  });
};

export const readDevRunnerConfig = () =>
  parseDevRunnerConfig({
    args: process.argv.slice(2),
    environment: process.env,
  });
