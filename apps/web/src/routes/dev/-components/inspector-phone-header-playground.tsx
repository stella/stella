import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";

import {
  InspectorTabHeader,
  MatterOriginLink,
} from "@/components/inspector/inspector-tab-header";
import { InspectorTabHeaderPending } from "@/components/inspector/inspector-tab-header-frame";
import { AVAILABLE_EVERYWHERE } from "@/lib/platform/requirements.logic";

/**
 * The inspector's tab header on a phone, pending and loaded, at the widths
 * the phone sheet gives it (a 390px and a 360px phone, less the backdrop the
 * sheet leaves beside it). The geometry spec measures Back, the tab switcher
 * and Close in both phases: the loaded header replaces the pending one in
 * place, so none of them may move.
 */
const PHONE_SHEET_WIDTHS = [341, 311] as const;

export const InspectorPhoneHeaderPlayground = () => (
  <div className="flex flex-col gap-6 p-4">
    {PHONE_SHEET_WIDTHS.map((width) => (
      <div className="flex flex-col gap-2" key={width}>
        <div
          className="border-border overflow-hidden rounded-md border"
          data-playground-section={`inspector-phone-header:pending:${width}`}
          style={{ width }}
        >
          <InspectorTabHeaderPending />
        </div>
        <div
          className="border-border overflow-hidden rounded-md border"
          data-playground-section={`inspector-phone-header:loaded:${width}`}
          style={{ width }}
        >
          <InspectorTabHeader
            actions={[
              {
                id: "download",
                requires: AVAILABLE_EVERYWHERE,
                render: () => (
                  <Button aria-label="Download" size="icon-xs" variant="ghost">
                    <DownloadIcon className="size-3.5" />
                  </Button>
                ),
              },
            ]}
            label="Share_Acquisition_Agreement.pdf"
            matter={
              <MatterOriginLink
                color={null}
                id="00000000-0000-4000-8000-000000000701"
                name="Meridian supply agreement"
                onClick={() => undefined}
              />
            }
            onClose={() => undefined}
          />
        </div>
      </div>
    ))}
  </div>
);
