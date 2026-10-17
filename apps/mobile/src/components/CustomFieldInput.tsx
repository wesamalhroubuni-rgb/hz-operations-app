import type {
  CustomFieldDescriptor,
  CustomFieldFieldError,
  CustomFieldFormValue,
} from '@ops/shared';

import { t } from '../i18n';
import { fromIsoDate, toIsoDate } from '../logic/dates';
import { ChoiceButtons } from './ChoiceButtons';
import { DateTimeField } from './DateTimeField';
import { TextField } from './FormField';
import { PickerField } from './PickerField';
import { YesNoField } from './YesNoField';

/** A select with at most this many options shows them as buttons; more open a list. */
const BUTTONS_UP_TO = 4;

/** One custom field of a log type, rendered from its descriptor (`@ops/shared` forms). */
export function CustomFieldInput({
  field,
  value,
  onChange,
  error,
}: Readonly<{
  field: CustomFieldDescriptor;
  value: CustomFieldFormValue | undefined;
  onChange: (value: CustomFieldFormValue) => void;
  error?: CustomFieldFieldError;
}>) {
  const message = error ? t(`logForm.fieldErrors.${error.code}`) : undefined;
  const common = { label: field.label, required: field.required, hint: field.helpText };
  const text = typeof value === 'string' ? value : '';

  switch (field.input) {
    case 'text':
      return (
        <TextField
          {...common}
          hint={field.helpText ?? undefined}
          value={text}
          onValueChange={onChange}
          error={message}
          autoCapitalize="sentences"
          autoCorrect
          spellCheck
          maxLength={2000}
        />
      );
    case 'number':
      return (
        <TextField
          {...common}
          hint={field.helpText ?? undefined}
          value={text}
          onValueChange={onChange}
          error={message}
          keyboardType="decimal-pad"
          inputMode="decimal"
        />
      );
    case 'yesNo':
      return (
        <YesNoField
          {...common}
          value={typeof value === 'boolean' ? value : null}
          onChange={onChange}
          error={message}
        />
      );
    case 'choice': {
      const choices = field.options.map((option) => ({ value: option, label: option }));
      return field.options.length <= BUTTONS_UP_TO ? (
        <ChoiceButtons
          {...common}
          choices={choices}
          value={text === '' ? null : text}
          onChange={(next) => onChange(next ?? '')}
          clearable={!field.required}
          error={message}
        />
      ) : (
        <PickerField
          {...common}
          hint={field.helpText ?? undefined}
          options={choices}
          value={text === '' ? null : text}
          onChange={(next) => onChange(next ?? '')}
          noneLabel={field.required ? undefined : t('common.notSet')}
          error={message}
        />
      );
    }
    case 'date':
      return (
        <DateTimeField
          {...common}
          mode="date"
          value={text === '' ? null : fromIsoDate(text)}
          onChange={(date) => onChange(date === null ? '' : toIsoDate(date))}
          emptyText={t('common.notSet')}
          clearLabel={field.required ? undefined : t('common.clear')}
          error={message}
        />
      );
  }
}
