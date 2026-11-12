/** The browser stack the local run suite and its stand-in computer use. */
export const LOCAL_RUN_ENV = {
  apiUrl: process.env["E2E_API_URL"] ?? "http://localhost:3001",
  webUrl: process.env["E2E_WEB_URL"] ?? "http://localhost:3000",
} as const;
