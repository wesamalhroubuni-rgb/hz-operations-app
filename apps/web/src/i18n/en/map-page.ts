// The `mapPage` namespace of the English catalogue. Owned by screen agent B (ADR-0009):
// the map of recent located work logs (GET /work-logs/map).
export const mapPage = {
  description: 'Recent work logs that recorded a location.',
  mapLabel: 'Map of recent work logs',
  range: 'From {{from}} to {{to}}',
  defaultRange: 'Without a date filter the map shows the last {{days}} days.',
  shown: { one: '{{count}} log on the map', other: '{{count}} logs on the map' },
  truncated: 'Showing the newest {{shown}} of {{total}}. Narrow the filters to see the rest.',
  listHeading: 'Logs on the map',
  listCaption: 'Located work logs',
  openLog: 'Open log',
  popupPhotos: { one: '{{count}} photo', other: '{{count}} photos' },
  empty: 'No work log with a location matches these filters.',
  coordinates: 'Position',
} as const;
