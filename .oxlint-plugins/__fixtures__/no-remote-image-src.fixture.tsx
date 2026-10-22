export const RemoteLiteral = () => (
  // oxlint-disable-next-line no-remote-image-src/no-remote-image-src -- Negative fixture: raw remote literal.
  <img alt="" src="https://example.org/icon.png" />
);

export const RemoteData = ({ iconUrl }: { iconUrl: string }) => (
  // oxlint-disable-next-line no-remote-image-src/no-remote-image-src -- Negative fixture: remote URL from data.
  <img alt="" src={iconUrl} />
);

// expect-clean: no-remote-image-src/no-remote-image-src
export const Local = ({ proxiedIconSrc }: { proxiedIconSrc: string }) => (
  <img alt="" src={proxiedIconSrc} />
);
export const Api = () => <img alt="" src="/v1/user-files/id/content" />;
export const Blob = () => <img alt="" src="blob:generated" />;
export const Data = () => <img alt="" src="data:image/png;base64,AAAA" />;
export const Avatar = () => (
  <img alt="" src="https://lh3.googleusercontent.com/avatar" />
);
