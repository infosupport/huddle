export type RuleStatus = 'allow' | 'deny' | 'requested';

export interface Rule {
  id: number;
  domain: string;
  container_id: string | null;
  container_name?: string;
  status: RuleStatus;
  created_at: number;
  updated_at: number;
  last_seen: number;
  request_count: number;
  expires_at?: number | null;
  path_pattern?: string | null;
  path_mode?: number;
  last_path?: string | null;
}
