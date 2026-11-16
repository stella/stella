/**
 * The document head every email shares: the content type, and the meta that
 * stops Apple Mail from reformatting the layout.
 */
export const Head = () => (
  <head>
    <meta content="text/html; charset=UTF-8" httpEquiv="Content-Type" />
    <meta name="x-apple-disable-message-reformatting" />
  </head>
);
