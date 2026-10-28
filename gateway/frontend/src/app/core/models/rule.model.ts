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
  /** 1 = TLS inspection off for this domain: the proxy keeps a raw tunnel. */
  no_intercept?: number;
  last_path?: string | null;
  group_id?: number | null;
  added_by?: string | null;
  source?: string;
}
