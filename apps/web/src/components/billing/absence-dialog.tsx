import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { isOrganizationManagementRole } from "@stll/permissions";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@stll/ui/tabs";
import { stellaToast } from "@stll/ui/toast";

import { usePermissions } from "@/hooks/use-permissions";
import { roleOptions } from "@/lib/auth-queries";

import { AbsenceList } from "./absence-list";
import { AbsenceRequestForm } from "./absence-request-form";

type AbsenceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialDate: string;
};

const AbsenceDialogBody = ({ initialDate }: { initialDate: string }) => {
  const t = useTranslations("billing.absences");
  const role = useQuery(roleOptions);
  const canRequest = usePermissions({ timeEntry: ["create"] });
  const canApprove = usePermissions({ timeEntry: ["approve"] });
  const manager =
    canApprove &&
    role.data !== undefined &&
    isOrganizationManagementRole(role.data);
  const [tab, setTab] = useState(() => (canRequest ? "request" : "mine"));
  const activeTab =
    (tab === "request" && !canRequest) || (tab === "approval_queue" && !manager)
      ? "mine"
      : tab;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("title")}</DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            if (typeof value === "string") {
              setTab(value);
            }
          }}
        >
          <TabsList className="flex-wrap">
            {canRequest && (
              <TabsTrigger className="min-h-11" value="request">
                {t("request")}
              </TabsTrigger>
            )}
            <TabsTrigger className="min-h-11" value="mine">
              {t("mine")}
            </TabsTrigger>
            {manager && (
              <TabsTrigger className="min-h-11" value="approval_queue">
                {t("approvalQueue")}
              </TabsTrigger>
            )}
          </TabsList>
          <ScrollArea className="max-h-[65dvh]">
            <div className="py-3 pe-3">
              {canRequest && (
                <TabsPanel value="request">
                  <AbsenceRequestForm
                    initialDate={initialDate}
                    onRequested={() => {
                      stellaToast.add({
                        title: t("requestSaved"),
                        type: "success",
                      });
                      setTab("mine");
                    }}
                  />
                </TabsPanel>
              )}
              <TabsPanel value="mine">
                <AbsenceList />
              </TabsPanel>
              {manager && (
                <TabsPanel value="approval_queue">
                  <AbsenceList review />
                </TabsPanel>
              )}
            </div>
          </ScrollArea>
        </Tabs>
      </DialogPanel>
    </>
  );
};

export const AbsenceDialog = ({
  open,
  onOpenChange,
  initialDate,
}: AbsenceDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogPopup className="max-w-2xl">
      {open && <AbsenceDialogBody initialDate={initialDate} />}
    </DialogPopup>
  </Dialog>
);
