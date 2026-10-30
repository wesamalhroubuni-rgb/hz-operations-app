'use client';

import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

import { t } from '@/i18n';

import styles from './ui.module.css';

/** What `FormField` hands its control so the label, hint and error are wired up. */
export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  'aria-required'?: true;
}

export interface FormFieldProps {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  /** Renders the control with the ids and ARIA attributes it needs. */
  children: (control: FieldControlProps) => ReactNode;
}

/**
 * A labelled field: label, control, hint and error, connected for screen readers
 * (`aria-describedby`, `aria-invalid`).
 *
 * @example
 * <FormField label={t('filters.site')} error={errors.siteId}>
 *   {(control) => <Select {...control} value={siteId} onChange={...}>...</Select>}
 * </FormField>
 */
export function FormField({ label, hint, error, required, children }: Readonly<FormFieldProps>) {
  const id = useId();
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {required ? (
          <span className={styles.requiredMark} aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children({
        id,
        ...(described ? { 'aria-describedby': described } : {}),
        ...(error ? { 'aria-invalid': true as const } : {}),
        ...(required ? { 'aria-required': true as const } : {}),
      })}
      {hint ? (
        <p id={`${id}-hint`} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function withControlClass(className: string | undefined): string {
  return className ? `${styles.control} ${className}` : (styles.control ?? '');
}

/** A text input styled for the dashboard. All native props pass through. */
export function Input({ className, ...rest }: Readonly<InputHTMLAttributes<HTMLInputElement>>) {
  return <input {...rest} className={withControlClass(className)} />;
}

export function Textarea({
  className,
  ...rest
}: Readonly<TextareaHTMLAttributes<HTMLTextAreaElement>>) {
  return <textarea {...rest} className={withControlClass(className)} />;
}

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * A native select (keyboard and screen-reader friendly by default). `placeholder` adds a first
 * empty option, e.g. "Any".
 */
export function Select({
  options,
  placeholder,
  className,
  ...rest
}: Readonly<
  SelectHTMLAttributes<HTMLSelectElement> & {
    options: readonly SelectOption[];
    placeholder?: string;
  }
>) {
  return (
    <select {...rest} className={withControlClass(className)}>
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** A checkbox with its label on the inline-end side. */
export function Checkbox({
  label,
  ...rest
}: Readonly<Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: string }>) {
  return (
    <label className={styles.checkboxRow}>
      <input {...rest} type="checkbox" />
      <span>{label}</span>
    </label>
  );
}

/** "Optional" / "Required" hint text, translated. */
export function requiredHint(required: boolean): string {
  return required ? t('common.required') : t('common.optional');
}
