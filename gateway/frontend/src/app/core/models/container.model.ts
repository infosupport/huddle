import { Rule } from './rule.model';
import { Grant } from './grant.model';

export type ContainerStatus = 'running' | 'stopped' | 'rogue';

export interface Container {
  id: string;
  name: string;
  image: string;
  status: string;
  created: number;
  workspacePath?: string;
  presentableName?: string;
  inNetwork?: boolean;
  huddleInNetwork?: boolean;
  ipAddress?: string;
  securityScore?: number;
  labels?: Record<string, string>;
  Labels?: Record<string, string>;
  airlocked?: boolean;
}

export interface ContainerDetail extends Container {
  rules: Rule[];
  globalRules: Rule[];
  grant?: Grant;
  huddleInNetwork?: boolean;
}

export interface DockerImage {
  id: string;
  name: string;
  tag: string;
  size: number;
  created: number;
  ide?: 'rider' | 'intellij';
}
