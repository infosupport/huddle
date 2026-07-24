export interface Grant {
  container: string;
  until: number;
}

export type GrantMap = Record<string, Grant>;

// Root grant: tijdgebonden passwordless sudo voor de default vscode-user.
export interface RootGrant {
  until: number;
}
