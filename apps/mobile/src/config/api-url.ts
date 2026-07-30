import * as v from "valibot";

const LOOPBACK_API_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const ANDROID_EMULATOR_HOST = "10.0.2.2";

type MobileRuntime = {
  buildMode: "development" | "production";
  deviceKind: "emulator" | "physical";
  platform: string;
};

export const shouldAllowAndroidEmulatorHttp = ({
  buildMode,
  deviceKind,
  platform,
}: MobileRuntime): boolean =>
  buildMode === "development" &&
  deviceKind === "emulator" &&
  platform === "android";

export const shouldAllowLoopbackHttp = ({
  buildMode,
  deviceKind,
  platform,
}: MobileRuntime): boolean =>
  buildMode === "development" &&
  (deviceKind === "emulator" || platform === "web");

const usesSecureTransport = (
  value: URL,
  {
    allowAndroidEmulatorHttp,
    allowLoopbackHttp,
  }: {
    allowAndroidEmulatorHttp: boolean;
    allowLoopbackHttp: boolean;
  },
): boolean =>
  value.protocol === "https:" ||
  (value.protocol === "http:" &&
    ((allowLoopbackHttp && LOOPBACK_API_HOSTS.has(value.hostname)) ||
      (allowAndroidEmulatorHttp && value.hostname === ANDROID_EMULATOR_HOST)));

const createApiUrlSchema = (options: {
  allowAndroidEmulatorHttp: boolean;
  allowLoopbackHttp: boolean;
}) =>
  v.pipe(
    v.string("EXPO_PUBLIC_API_URL is required."),
    v.url("EXPO_PUBLIC_API_URL must be a valid URL."),
    v.transform((value) => new URL(value)),
    v.check(
      (value) => usesSecureTransport(value, options),
      "EXPO_PUBLIC_API_URL must use HTTPS (HTTP is allowed only for a loopback development server or Android emulator alias in development).",
    ),
    v.check(
      (value) =>
        value.username === "" &&
        value.password === "" &&
        value.search === "" &&
        value.hash === "",
      "EXPO_PUBLIC_API_URL cannot contain credentials, query parameters, or a fragment.",
    ),
    v.transform((value) => value.href),
  );

export const parseMobileApiUrl = (
  value: unknown,
  { allowAndroidEmulatorHttp = false, allowLoopbackHttp = false } = {},
) =>
  v.parse(
    createApiUrlSchema({ allowAndroidEmulatorHttp, allowLoopbackHttp }),
    value,
  );
