type SettingsPageHeaderProps = {
  title: string;
  description?: string;
};

export const SettingsPageHeader = ({
  title,
  description,
}: SettingsPageHeaderProps) => (
  <header className="flex flex-col gap-1">
    <h1 className="text-xl font-semibold">{title}</h1>
    {description && (
      <p className="text-muted-foreground text-sm">{description}</p>
    )}
  </header>
);
