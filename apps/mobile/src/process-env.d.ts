declare namespace NodeJS {
  interface ProcessEnv {
    readonly EXPO_OS?: "android" | "ios" | "web";
    readonly EXPO_PUBLIC_API_URL: string | undefined;
  }
}
