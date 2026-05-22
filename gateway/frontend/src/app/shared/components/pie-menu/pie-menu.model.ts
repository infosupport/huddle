export type PieIconName = 'approve' | 'approve-all' | 'deny' | 'deny-all' | 'timer' | 'timer-long' | 'later';
export type PieTone = 'green' | 'red' | 'blue' | 'neutral';

export interface PieVariant {
  id: string;
  label: string;
  icon: PieIconName;
}

export interface PieFamily {
  id: string;
  label: string;
  tone: PieTone;
  icon: PieIconName;
  variants?: PieVariant[];
}

export interface PieMenuConfig {
  families: [PieFamily, PieFamily, PieFamily];
}

export const PIE_TONES: Record<PieTone, { fg: string; bg: string; bgHover: string; ring: string }> = {
  green:   { fg: '#1f7a47', bg: '#e6f4ec', bgHover: '#d4ebde', ring: '#7ec9a3' },
  red:     { fg: '#b3261e', bg: '#fbe7e6', bgHover: '#f6d4d2', ring: '#e89a95' },
  blue:    { fg: '#2452a8', bg: '#e7ecfa', bgHover: '#d6def5', ring: '#8aa3df' },
  neutral: { fg: '#3a3a38', bg: '#efece6', bgHover: '#e4e0d6', ring: '#bdb8ac' },
};

// Three 120° arcs: top, bottom-right, bottom-left
export const PIE_ARCS = [
  { start: -150, end: -30  },
  { start:  -30, end:  90  },
  { start:   90, end:  210 },
] as const;
