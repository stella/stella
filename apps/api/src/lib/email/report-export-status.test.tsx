import { describe, expect, test } from "bun:test";

import { renderReportExportStatusEmail } from "@/api/lib/email/email";

describe("report export status email", () => {
  test("renders only generic status copy and an application link", async () => {
    const rendered = await Promise.all(
      (["completed", "failed"] as const).map(
        async (status) =>
          await renderReportExportStatusEmail({
            appUrl: "https://stella.example/workspaces",
            lang: "en",
            status,
          }),
      ),
    );

    for (const email of rendered) {
      expect(email.html).toContain("https://stella.example/workspaces");
      expect(email.text).toContain("This email contains no report content");
      expect(email.html).not.toContain("result_s3_key");
      expect(email.html).not.toContain("template_ref");
      expect(email.html).not.toContain("requested_by");
    }
  });
});
