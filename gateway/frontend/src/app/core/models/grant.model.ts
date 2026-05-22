export interface Grant {
  container: string;
  until: number;
}

export type GrantMap = Record<string, Grant>;
