export type DocSource = {
  dependency: string;
  url: string;
};

export const DOC_SOURCES = {
  Elysia: { dependency: "elysia", url: "https://elysiajs.com/llms.txt" },
  Drizzle: {
    dependency: "drizzle-orm",
    url: "https://orm.drizzle.team/llms.txt",
  },
  TanStack: {
    dependency: "@tanstack/ai",
    url: "https://tanstack.com/llms.txt",
  },
  TanStackStart: {
    dependency: "@tanstack/react-start",
    url: "https://tanstack.com/start/latest/llms.txt",
  },
  React: { dependency: "react", url: "https://react.dev/llms.txt" },
  ReactEmail: {
    dependency: "@react-email/components",
    url: "https://react.email/docs/llms.txt",
  },
  BaseUI: {
    dependency: "@base-ui/react",
    url: "https://base-ui.com/llms.txt",
  },
  Valibot: { dependency: "valibot", url: "https://valibot.dev/llms.txt" },
  TipTap: {
    dependency: "@tiptap/core",
    url: "https://tiptap.dev/docs/llms.txt",
  },
  Tauri: {
    dependency: "@tauri-apps/api",
    url: "https://v2.tauri.app/llms.txt",
  },
  Vite: { dependency: "vite", url: "https://vite.dev/llms.txt" },
  Expo: { dependency: "expo", url: "https://docs.expo.dev/llms.txt" },
  MCP: {
    dependency: "@modelcontextprotocol/server",
    url: "https://modelcontextprotocol.io/llms.txt",
  },
  AWSSDK: {
    dependency: "@aws-sdk/client-s3",
    url: "https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/llms.txt",
  },
  AGUI: {
    dependency: "@ag-ui/core",
    url: "https://docs.ag-ui.com/llms.txt",
  },
  Bun: { dependency: "bun-types", url: "https://bun.sh/llms.txt" },
  BetterAuth: {
    dependency: "better-auth",
    url: "https://better-auth.com/llms.txt",
  },
  Turborepo: {
    dependency: "turbo",
    url: "https://turborepo.dev/llms.txt",
  },
  PostHog: {
    dependency: "posthog-js",
    url: "https://posthog.com/llms.txt",
  },
  Zustand: {
    dependency: "zustand",
    url: "https://zustand.docs.pmnd.rs/llms.txt",
  },
  Oxlint: { dependency: "oxlint", url: "https://oxc.rs/llms.txt" },
} as const satisfies Record<string, DocSource>;
