// The sign-in callback page's colour tokens. The CLI serves that page itself,
// so no app stylesheet reaches it: its palette is named once here, and the
// page's styles read it with `var(--token)`.
export const CALLBACK_PAGE_THEME_CSS = `
      :root {
        --page-background: #fafafa;
        --page-foreground: #18181b;
        --card-background: #ffffff;
        --card-border: rgb(24 24 27 / 8%);
        --card-shadow-near: rgb(24 24 27 / 4%);
        --card-shadow-far: rgb(24 24 27 / 8%);
        --label-foreground: #71717a;
        --body-foreground: #52525b;
        --status-success: #18181b;
        --status-failure: #b91c1c;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --page-background: #09090b;
          --page-foreground: #fafafa;
          --card-background: #18181b;
          --card-border: rgb(250 250 250 / 8%);
          --card-shadow-far: rgb(0 0 0 / 24%);
          --label-foreground: #a1a1aa;
          --body-foreground: #a1a1aa;
          --status-success: #fafafa;
          --status-failure: #fca5a5;
        }
      }`;
