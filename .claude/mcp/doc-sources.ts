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
    url: "https://tanstack.com/start/latest/docs/framework/react/overview.md",
  },
  React: { dependency: "react", url: "https://react.dev/llms.txt" },
  BaseUI: {
    dependency: "@base-ui/react",
    url: "https://base-ui.com/llms.txt",
  },
  AtlassianDesign: {
    dependency: "@atlaskit/pragmatic-drag-and-drop",
    url: "https://atlassian.design/llms.txt",
  },
  Valibot: { dependency: "valibot", url: "https://valibot.dev/llms.txt" },
  TipTap: {
    dependency: "@tiptap/core",
    url: "https://tiptap.dev/llms.txt",
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
