import { usePresentationPrefs } from "@/lib/presentation-prefs/provider";

export const useReaderProvisionMode = () => {
  const { prefs, setPrefs } = usePresentationPrefs();
  return {
    expandProvisions: prefs.readerProvisionMode === "expanded",
    toggle: () =>
      setPrefs({
        readerProvisionMode:
          prefs.readerProvisionMode === "expanded" ? "collapsed" : "expanded",
      }),
  };
};
