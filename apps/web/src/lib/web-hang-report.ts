import { TaggedError } from "better-result";

import { fetchWithTimeout } from "@stll/fetch";

import { apiUrl } from "@/lib/api-url";

class WebHangReportError extends TaggedError("WebHangReportError")<{
  message: string;
}> {}

export const reportWebPageHang = async (phase: "boot" | "session") => {
  const response = await fetchWithTimeout(
    apiUrl("/client-telemetry/web-page-hang"),
    {
      method: "POST",
      timeout: { type: "headers", ms: 5000 },
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase }),
      keepalive: true,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    },
  );
  if (!response.ok) {
    throw new WebHangReportError({ message: "Hang report rejected" });
  }
};
