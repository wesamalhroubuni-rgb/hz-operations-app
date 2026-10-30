// The `settings` namespace of the English catalogue. Owned by screen agent C (ADR-0009).
export const settings = {
  description: 'Organization name and the rules the apps follow.',
  apiStatus: 'API status',
  noApiUrl: 'No API URL',
  checkAgain: 'Check again',
  general: 'Organization',
  rules: 'Work log rules',
  name: 'Organization name',
  slug: 'Sign-in identifier: {{slug}}',
  timeZone: 'Time zone',
  timeZoneHint:
    'Times in the dashboard, reports and exports are shown in this zone, and "today" is counted in it.',
  workLogEditWindowHours: 'Edit window (hours)',
  workLogEditWindowHoursHint:
    'How long after creating a work log its author may still change it. At most {{max}} hours.',
  offlineMaxBackdateDays: 'Offline backdating limit (days)',
  offlineMaxBackdateDaysHint:
    'How many days in the past a new log may be dated, for logs saved offline. 1 to {{max}} days.',
  submit: 'Save settings',
  saved: 'Settings saved.',
  reset: 'Undo changes',
  needsAdmin: 'Only administrators can see and change the settings.',
  errors: {
    required: 'Required.',
    number: 'Enter a number.',
    range: 'Out of the allowed range.',
    wholeNumber: 'Enter a whole number.',
    timeZone: 'Choose a valid time zone.',
  },
} as const;
