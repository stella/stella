import { useReducer, useState } from "react";

export const SettingsSurfaceBefore = ({ ready }) => {
  const [, setReady] = useState(false);
  if (ready) {
    // oxlint-disable-next-line no-render-phase-update/no-render-phase-update -- detector fixture: the unguarded render update must be rejected
    setReady(true);
  }
  return null;
};

export const SettingsSurfaceAfter = ({ ready }) => {
  const [previousReady, setPreviousReady] = useState(ready);
  if (previousReady !== ready) {
    setPreviousReady(ready);
  }
  return null;
};

export const NavigationBefore = ({ router }) => {
  const [, dispatch] = useReducer((value) => value + 1, 0);
  // oxlint-disable-next-line no-render-phase-update/no-render-phase-update -- detector fixture: render-time navigation must be rejected
  router.navigate({ to: "/settings" });
  // oxlint-disable-next-line no-render-phase-update/no-render-phase-update -- detector fixture: render-time dispatch must be rejected
  dispatch();
  // oxlint-disable-next-line no-render-phase-update/no-render-phase-update -- detector fixture: render-time redirects must be rejected
  throw redirect({ to: "/settings" });
};

export const NavigationAfter = ({ router }) => {
  const [, dispatch] = useReducer((value) => value + 1, 0);
  return (
    <button
      type="button"
      onClick={() => {
        router.navigate({ to: "/settings" });
        dispatch();
      }}
    >
      Open
    </button>
  );
};

export const Route = createFileRoute("/settings")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
