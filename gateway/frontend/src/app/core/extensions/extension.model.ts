export interface ExtensionSetting {
  key: string;
  label: string;
  secret: boolean;
}

export interface Extension {
  id: string;
  name: string;
  icon: string;
  version?: string | null;
  enabled?: boolean;
  settings: ExtensionSetting[];
}
