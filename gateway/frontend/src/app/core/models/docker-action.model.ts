export type DockerActionKind = 'temporary' | 'always' | 'mount';

export type DockerActionGroup = 'containers' | 'images' | 'volumes' | 'networks' | 'system' | 'mounts';

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
  /** Effective toggle state per action, including defaults for all actions. */
  policies: Record<string, boolean>;
  /** Active grant timer for this container, or null if there is none. */
  grant: { until: number } | null;
}

export interface DockerActionPolicyResult {
  container: string;
  action: string;
  enabled: boolean;
}
