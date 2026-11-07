// oxlint-disable-next-line no-hookless-use-function/no-hookless-use-function -- fixture: a hook name on a pure formatter
export function useItemLabel(count: number) {
  return `${count} items`;
}

// oxlint-disable-next-line no-hookless-use-function/no-hookless-use-function -- fixture: the hook runs in the returned callback, not during render
export const useStoreReader = () => () => useStoreState();

// expect-clean: no-hookless-use-function/no-hookless-use-function
export const useCounter = () => useStoreState();

// expect-clean: no-hookless-use-function/no-hookless-use-function
export const useThemeValue = () => use(themeContext);

// expect-clean: no-hookless-use-function/no-hookless-use-function
export const formatItemLabel = (count: number) => `${count} items`;

declare const useStoreState: () => number;
declare const use: (context: unknown) => unknown;
declare const themeContext: unknown;
