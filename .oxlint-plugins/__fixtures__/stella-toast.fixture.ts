// Passive regression fixture for stella-toast.

// oxlint-disable-next-line stella-toast/stella-toast -- fixture: raw Base UI manager skips Stella defaults
import { toastManager as rawManager } from "@base-ui/react/toast";

// The wrapper itself, through the grouped module path.
// expect-clean: stella-toast/stella-toast
import { stellaToast as groupedStellaToast } from "@stll/ui/components/toast";
// oxlint-disable-next-line stella-toast/stella-toast -- fixture: restricted wrapper export instead of stellaToast
import { stellaToast, toastManager } from "@stll/ui/toast";

void rawManager;
void toastManager;
void stellaToast;
void groupedStellaToast;
