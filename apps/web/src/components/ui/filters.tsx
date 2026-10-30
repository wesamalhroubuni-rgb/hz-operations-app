'use client';

import type { DayKey } from '@ops/shared';
import { useEffect, useState, type ReactNode } from 'react';

import { t } from '@/i18n';
import { presetDays, type DatePreset } from '@/lib/time';

import { Button } from './button';
import { FormField, Input, Select, type SelectOption } from './form-field';
import styles from './ui.module.css';

/**
 * The box of filters above a table: a heading, the fields in a responsive grid, and "Clear
 * filters" when any is set. The fields write to the URL through `useListParams`.
 */
export function FilterBar({
  children,
  activeCount,
  onClear,
}: Readonly<{ children: ReactNode; activeCount: number; onClear: () => void }>) {
  return (
    <section className={styles.filterBar} aria-label={t('filters.label')}>
      <div className={styles.filterHead}>
        <h2 className={styles.filterTitle}>
          {t('filters.label')}
          {activeCount > 0 ? ` · ${t('filters.active', { count: activeCount })}` : ''}
        </h2>
        {activeCount > 0 ? (
          <Button variant="ghost" size="sm" onClick={onClear}>
            {t('filters.clearAll')}
          </Button>
        ) : null}
      </div>
      <div className={styles.filterGrid}>{children}</div>
    </section>
  );
}

/** A labelled select whose empty first option means "any". */
export function SelectFilter({
  label,
  value,
  options,
  onChange,
  anyLabel = t('filters.any'),
}: Readonly<{
  label: string;
  value: string | undefined;
  options: readonly SelectOption[];
  onChange: (value: string | null) => void;
  anyLabel?: string;
}>) {
  return (
    <FormField label={label}>
      {(control) => (
        <Select
          {...control}
          value={value ?? ''}
          options={options}
          placeholder={anyLabel}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        />
      )}
    </FormField>
  );
}

/**
 * A search box that writes its value after the user pauses (`delayMs`) or presses Enter, so the
 * URL and the API are not hit on every keystroke.
 */
export function SearchFilter({
  label = t('filters.search'),
  value,
  onChange,
  delayMs = 400,
  placeholder,
}: Readonly<{
  label?: string;
  value: string | undefined;
  onChange: (value: string | null) => void;
  delayMs?: number;
  placeholder?: string;
}>) {
  const [text, setText] = useState(value ?? '');
  const [lastValue, setLastValue] = useState(value);
  // The URL changed from elsewhere (back button, "Clear filters"): show its value.
  if (value !== lastValue) {
    setLastValue(value);
    setText(value ?? '');
  }

  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === (value ?? '')) {
      return;
    }
    const timer = setTimeout(() => onChange(trimmed === '' ? null : trimmed), delayMs);
    return () => clearTimeout(timer);
  }, [text, value, delayMs, onChange]);

  return (
    <FormField label={label}>
      {(control) => (
        <Input
          {...control}
          type="search"
          value={text}
          placeholder={placeholder}
          maxLength={200}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              const trimmed = text.trim();
              onChange(trimmed === '' ? null : trimmed);
            }
          }}
        />
      )}
    </FormField>
  );
}

export interface DayRange {
  from: DayKey | null;
  to: DayKey | null;
}

const PRESETS: readonly DatePreset[] = ['today', 'yesterday', 'last7Days', 'last30Days'];

/**
 * Two date inputs (first and last day, both included) and quick presets. Days are calendar days
 * in the ORGANIZATION's time zone: `today` must come from `useOrgTime().today()`. Turn the
 * result into API instants with `useOrgTime().range(from, to)`; show a URL's instants back with
 * `daysOfRange` (src/lib/time.ts).
 */
export function DateRangePicker({
  label = t('filters.dateRange'),
  value,
  today,
  onChange,
  presets = true,
}: Readonly<{
  label?: string;
  value: DayRange;
  today: DayKey;
  onChange: (range: DayRange) => void;
  presets?: boolean;
}>) {
  const invalid = value.from !== null && value.to !== null && value.to < value.from;
  return (
    <fieldset className={`${styles.field} ${styles.fieldset}`}>
      <legend className={styles.label}>{label}</legend>
      <div className={styles.dateRange}>
        <FormField label={t('filters.from')} error={invalid ? t('dates.invalidRange') : null}>
          {(control) => (
            <Input
              {...control}
              type="date"
              value={value.from ?? ''}
              max={value.to ?? today}
              onChange={(event) => onChange({ ...value, from: event.target.value || null })}
            />
          )}
        </FormField>
        <FormField label={t('filters.to')}>
          {(control) => (
            <Input
              {...control}
              type="date"
              value={value.to ?? ''}
              min={value.from ?? undefined}
              max={today}
              onChange={(event) => onChange({ ...value, to: event.target.value || null })}
            />
          )}
        </FormField>
      </div>
      {presets ? (
        <div className={styles.presets}>
          {PRESETS.map((preset) => (
            <Button
              key={preset}
              size="sm"
              variant="ghost"
              onClick={() => onChange(presetDays(preset, today))}
            >
              {t(`dates.${preset}`)}
            </Button>
          ))}
          {value.from !== null || value.to !== null ? (
            <Button size="sm" variant="ghost" onClick={() => onChange({ from: null, to: null })}>
              {t('dates.anyTime')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
