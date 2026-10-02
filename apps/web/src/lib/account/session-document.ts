import { hasCurrentTabStorageOwner } from "@/lib/account/user-scoped-storage";

export const hideSessionDocument = () => {
  document.documentElement.hidden = true;
};

export const listenForSessionDocumentRestore = (listener: () => void) => {
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) {
      return;
    }
    if (!hasCurrentTabStorageOwner()) {
      hideSessionDocument();
      window.location.reload();
      return;
    }
    listener();
  };
  window.addEventListener("pageshow", onPageShow);
  return () => {
    window.removeEventListener("pageshow", onPageShow);
  };
};
