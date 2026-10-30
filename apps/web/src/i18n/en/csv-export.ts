// The `csvExport` namespace of the English catalogue. Owned by screen agent B (ADR-0009):
// the CSV export buttons (GET /exports/work-logs.csv and /exports/tasks.csv).
export const csvExport = {
  button: 'Export CSV',
  exporting: 'Exporting…',
  hint: 'Exports every row that matches the current filters (not only this page).',
  done: 'The file was downloaded.',
  tooLarge:
    'Too many rows to export: at most {{max}} rows fit in one file. Narrow the filters (for example a shorter date range) and try again.',
  forbidden: 'Your role cannot export this list.',
  failed: 'The export failed: {{reason}}',
} as const;
