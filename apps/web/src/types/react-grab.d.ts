// biome-ignore lint/style/useConsistentTypeDefinitions: interface required for global augmentation
interface Window {
  __REACT_GRAB__?: {
    activate: () => void;
    setEnabled: (enabled: boolean) => void;
    isEnabled: () => boolean;
    setOptions: (options: { toolbar?: { enabled?: boolean } }) => void;
  };
}
