// Passive regression fixture for
// `no-direct-dom-unregister/no-direct-dom-unregister`.

export const removeDomGlobalsDirectly = async (): Promise<void> => {
  // MUST flag: direct teardown can remove globals before React work drains.
  // oxlint-disable-next-line no-direct-dom-unregister/no-direct-dom-unregister -- fixture: direct unregister bypasses the shared scheduler drain
  await GlobalRegistrator.unregister();
};

export const removeDomGlobalsSafely = async (): Promise<void> => {
  // expect-clean: no-direct-dom-unregister/no-direct-dom-unregister
  await unregisterDomEnvironment();
};
