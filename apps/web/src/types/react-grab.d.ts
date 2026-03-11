// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface Window {
  __REACT_GRAB__?: {
    activate: () => void;
    setEnabled: (enabled: boolean) => void;
    isEnabled: () => boolean;
    setOptions: (options: { toolbar?: { enabled?: boolean } }) => void;
  };
}
