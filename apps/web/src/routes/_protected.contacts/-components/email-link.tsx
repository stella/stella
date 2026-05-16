export const EmailLink = ({ address }: { address: string }) => (
  <a
    className="hover:text-foreground min-w-0 break-all hover:underline"
    href={`mailto:${address}`}
  >
    {address}
  </a>
);
