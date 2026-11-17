import type { SVGProps } from 'react';

/**
 * The dashboard's line icons (24 × 24, 1.75 stroke, `currentColor`). Decorative: every use sits
 * next to a text label, so they are hidden from screen readers.
 */
export type IconName =
  | 'overview'
  | 'workLogs'
  | 'tasks'
  | 'map'
  | 'summaries'
  | 'people'
  | 'structure'
  | 'audit'
  | 'settings'
  | 'aiUsage'
  | 'clock'
  | 'alert'
  | 'blocked'
  | 'inbox'
  | 'menu'
  | 'close';

const PATHS: Record<IconName, string[]> = {
  overview: ['M4 4h7v7H4z', 'M13 4h7v4h-7z', 'M13 10h7v10h-7z', 'M4 13h7v7H4z'],
  workLogs: [
    'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z',
    'M14 3v5h5',
    'M9 13h6',
    'M9 17h6',
  ],
  tasks: [
    'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
    'M8.5 12l2.5 2.5 4.5-5',
  ],
  map: [
    'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z',
    'M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  ],
  summaries: [
    'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z',
    'M18.5 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z',
  ],
  people: [
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    'M3 20a6 6 0 0 1 12 0',
    'M16 4.5a3.5 3.5 0 0 1 0 6.5',
    'M18 14.5a5.5 5.5 0 0 1 3 5.5',
  ],
  structure: ['M12 3l9 5-9 5-9-5z', 'M3 13l9 5 9-5', 'M3 17.5l9 5 9-5'],
  audit: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v4h4', 'M12 7.5V12l3 2'],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  ],
  aiUsage: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M21 20H3'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  alert: ['M12 3l9.5 17h-19z', 'M12 10v4', 'M12 17.5v.01'],
  blocked: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M5.6 5.6l12.8 12.8'],
  inbox: ['M3 13h5l1.5 3h5L16 13h5', 'M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
};

export function Icon({
  name,
  size = 20,
  ...props
}: Readonly<{ name: IconName; size?: number } & SVGProps<SVGSVGElement>>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
