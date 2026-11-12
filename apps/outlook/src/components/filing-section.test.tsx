import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { toSafeId } from "@stll/api-contract/safe-id";

import { FilingSection } from "@/components/filing-section";
import type { FileEmailState } from "@/hooks/use-file-email";
import { translator } from "@/i18n";
import type { WorkspaceSummary } from "@/types";

const matter = (id: string, name: string): WorkspaceSummary => ({
  clientName: null,
  id: toSafeId<"workspace">(id),
  lastActivityAt: null,
  name,
  reference: null,
});

const FILED_TO = matter("workspace-a", "Acme acquisition");
const SUGGESTED = matter("workspace-b", "Beta dispute");

const render = (saveState: FileEmailState) =>
  renderToStaticMarkup(
    <FilingSection
      matches={[FILED_TO, SUGGESTED]}
      onChoose={() => undefined}
      onFile={() => undefined}
      onQueryChange={() => undefined}
      query=""
      saveState={saveState}
      t={translator}
      target={SUGGESTED}
      targetIsSuggestion
      workspaceError={null}
    />,
  );

const complete = (
  skippedAttachments: readonly string[],
): Extract<FileEmailState, { type: "complete" }> => ({
  result: {
    entityId: toSafeId<"entity">("entity-1"),
    fieldId: null,
    fileName: "email.eml",
    workspaceId: FILED_TO.id,
  },
  skippedAttachments,
  source: "rebuilt",
  type: "complete",
  workspace: FILED_TO,
});

describe("FilingSection", () => {
  test("names the matter the email was filed to, not the current suggestion", () => {
    const html = render(complete([]));
    expect(html).toContain(FILED_TO.name);
    expect(html).not.toContain(SUGGESTED.name);
    expect(html).toContain("Filed with its attachments");
  });

  test("does not claim attachments it left out were filed", () => {
    const html = render(complete(["logo.png"]));
    expect(html).toContain("Filed without some of its attachments");
    expect(html).not.toContain("Filed with its attachments");
    expect(html).toContain("logo.png");
  });

  test("keeps an unconfirmed upload on its own matter", () => {
    const html = render({
      message: "Not confirmed yet.",
      retry: {
        pending: {
          propertyId: toSafeId<"property">("property-1"),
          uploadId: toSafeId<"pendingUpload">("upload-1"),
          workspaceId: FILED_TO.id,
        },
        skippedAttachments: [],
        source: "mailbox",
        workspace: FILED_TO,
      },
      type: "error",
    });
    expect(html).toContain(FILED_TO.name);
    expect(html).not.toContain(SUGGESTED.name);
    expect(html).toContain("Finish saving");
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>(?:<span[^>]*>)?Change</u,
    );
  });

  test("offers the suggested matter when nothing is pending", () => {
    const html = render({ type: "idle" });
    expect(html).toContain(SUGGESTED.name);
    expect(html).toContain("File email");
  });
});
