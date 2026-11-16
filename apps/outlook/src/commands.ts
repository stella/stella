import { waitForOffice } from "@/lib/office";

waitForOffice().catch(() => {
  // The task pane owns all V1 actions; command file exists for the manifest.
});
