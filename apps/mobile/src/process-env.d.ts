// Expo inlines an `EXPO_PUBLIC_*` value only where it is read with dot
// access (src/env.ts), so each one the app reads is declared here.
declare namespace NodeJS {
  interface ProcessEnv {
    readonly EXPO_PUBLIC_STELLA_SERVER_URL?: string;
  }
}
