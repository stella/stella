type ToolNote = {
  audience: "agent" | "user";
  message: string;
};

export const ToolNotes = ({ notes }: { notes: readonly ToolNote[] }) => {
  const messages = new Set(
    notes
      .filter(({ audience }) => audience === "user")
      .map(({ message }) => message),
  );
  return [...messages].map((message) => (
    <p role="status" className="text-muted-foreground text-xs" key={message}>
      {message}
    </p>
  ));
};
