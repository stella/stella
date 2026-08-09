// Passive regression fixture for stella-toast.

// oxlint-disable-next-line stella-toast/stella-toast -- fixture: raw Base UI manager bypasses Stella defaults
import { toastManager as rawManager } from "@base-ui/react/toast";

// oxlint-disable-next-line stella-toast/stella-toast -- fixture: restricted wrapper export bypasses stellaToast
import { stellaToast, toastManager } from "@stll/ui/components/toast";

void rawManager;
void toastManager;
void stellaToast;
