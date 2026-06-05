export interface ExtensionSetting {
  key: string;
  label: string;
  secret: boolean;
}

export interface Extension {
  id: string;
  name: string;
  icon: string;
  settings: ExtensionSetting[];
}
