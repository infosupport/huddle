export type DockerActionKind = 'temporary' | 'always';

export type DockerActionGroup = 'containers' | 'images' | 'volumes' | 'networks' | 'system';

export interface DockerActionDef {
  action: string;
  kind: DockerActionKind;
  group: DockerActionGroup;
  label: string;
  defaultEnabled: boolean;
}

export interface DockerActionCatalog {
  actions: DockerActionDef[];
}

export interface DockerActionPolicies {
  /** Effectieve togglestand per actie, inclusief defaults voor alle acties. */
  policies: Record<string, boolean>;
  /** Actieve grant-timer voor deze container, of null als er geen is. */
  grant: { until: number } | null;
}

export interface DockerActionPolicyResult {
  container: string;
  action: string;
  enabled: boolean;
}
