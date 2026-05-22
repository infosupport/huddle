export interface AuditLog {
  id: number;
  ts: number;
  container_id: string | null;
  domain: string;
  port: number | null;
  action: string;
  rule_id: number | null;
  method: string | null;
  path: string | null;
  req_headers: string | null;
  req_body: string | null;
  res_status: number | null;
  res_headers: string | null;
  res_body: string | null;
}
