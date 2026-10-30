'use client';

import { CUSTOM_FIELD_TYPES, type CustomFieldType } from '@ops/shared';

import { Warning } from '@/components/manage/parts';
import { Button } from '@/components/ui/button';
import { Checkbox, FormField, Input, Select } from '@/components/ui/form-field';
import { t, type TranslationKey } from '@/i18n';
import type { EditorAction, EditorField, FieldErrors } from '@/lib/log-type-editor';

import styles from '../manage/manage.module.css';

function errorText(code: string | undefined): string | null {
  return code ? t(`structure.fields.errors.${code}` as TranslationKey) : null;
}

/**
 * The ordered list of custom fields of a log type (ADR-0003). Props only (state lives in
 * `editorReducer`), so it renders in tests. Saved fields show their key read-only; reordering
 * is done with Move up / Move down buttons, usable with the keyboard; `newUid` makes ids for
 * added fields.
 */
export function CustomFieldEditor({
  fields,
  errors,
  dispatch,
  newUid,
  announcement,
  storedTypes,
}: Readonly<{
  fields: readonly EditorField[];
  errors: Record<string, FieldErrors>;
  dispatch: (action: EditorAction) => void;
  newUid: () => string;
  /** Polite live-region text after a move ("Depth moved to position 2."). */
  announcement?: string | null;
  /** Types of the stored fields by key: a warning shows when a saved field's type changes. */
  storedTypes?: Readonly<Record<string, CustomFieldType>>;
}>) {
  const name = (field: EditorField) => field.label.trim() || t('structure.fields.untitled');
  return (
    <section aria-labelledby="fields-title" className={styles.stack}>
      <div className={styles.row}>
        <h3 id="fields-title" className={styles.cardTitle}>
          {t('structure.fields.title')}
        </h3>
        <Button size="sm" onClick={() => dispatch({ type: 'add', uid: newUid() })}>
          {t('structure.fields.add')}
        </Button>
      </div>
      <p className={styles.muted} aria-live="polite">
        {announcement ?? ''}
      </p>
      {fields.length === 0 ? <p className={styles.muted}>{t('structure.fields.empty')}</p> : null}
      <ol className={styles.fieldList}>
        {fields.map((field, index) => {
          const own = errors[field.uid] ?? {};
          return (
            <li key={field.uid} className={styles.fieldItem} data-field-key={field.key}>
              <div className={styles.fieldHead}>
                <h4 className={styles.fieldTitle}>
                  {t('structure.fields.field', { position: index + 1 })} · {name(field)}
                </h4>
                <div className={styles.row}>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === 0}
                    onClick={() => dispatch({ type: 'move', uid: field.uid, delta: -1 })}
                    aria-label={t('structure.fields.moveUp', { name: name(field) })}
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === fields.length - 1}
                    onClick={() => dispatch({ type: 'move', uid: field.uid, delta: 1 })}
                    aria-label={t('structure.fields.moveDown', { name: name(field) })}
                  >
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => dispatch({ type: 'remove', uid: field.uid })}
                    aria-label={t('structure.fields.remove', { name: name(field) })}
                  >
                    {t('common.remove')}
                  </Button>
                </div>
              </div>
              <div className={styles.formGrid}>
                <FormField
                  label={t('structure.fields.label')}
                  required
                  error={errorText(own.label)}
                >
                  {(control) => (
                    <Input
                      {...control}
                      value={field.label}
                      maxLength={200}
                      onChange={(event) =>
                        dispatch({
                          type: 'update',
                          uid: field.uid,
                          patch: { label: event.target.value },
                        })
                      }
                    />
                  )}
                </FormField>
                <FormField
                  label={t('structure.fields.key')}
                  hint={
                    field.saved ? t('structure.fields.keyLocked') : t('structure.fields.keyHint')
                  }
                  error={errorText(own.key)}
                >
                  {(control) => (
                    <Input
                      {...control}
                      className={styles.mono}
                      value={field.key}
                      maxLength={64}
                      readOnly={field.saved}
                      aria-readonly={field.saved || undefined}
                      onChange={(event) =>
                        field.saved
                          ? undefined
                          : dispatch({
                              type: 'update',
                              uid: field.uid,
                              patch: { key: event.target.value },
                            })
                      }
                    />
                  )}
                </FormField>
                <FormField label={t('structure.fields.type')}>
                  {(control) => (
                    <Select
                      {...control}
                      value={field.type}
                      options={CUSTOM_FIELD_TYPES.map((value) => ({
                        value,
                        label: t(`structure.fields.types.${value}` as TranslationKey),
                      }))}
                      onChange={(event) =>
                        dispatch({
                          type: 'update',
                          uid: field.uid,
                          patch: { type: event.target.value as CustomFieldType },
                        })
                      }
                    />
                  )}
                </FormField>
                <FormField label={t('structure.fields.helpText')}>
                  {(control) => (
                    <Input
                      {...control}
                      value={field.helpText}
                      maxLength={500}
                      onChange={(event) =>
                        dispatch({
                          type: 'update',
                          uid: field.uid,
                          patch: { helpText: event.target.value },
                        })
                      }
                    />
                  )}
                </FormField>
              </div>
              <Checkbox
                label={t('structure.fields.required')}
                checked={field.required}
                onChange={(event) =>
                  dispatch({
                    type: 'update',
                    uid: field.uid,
                    patch: { required: event.target.checked },
                  })
                }
              />
              {field.type === 'select' ? (
                <fieldset className={styles.fieldset}>
                  <legend className={styles.legend}>{t('structure.fields.options')}</legend>
                  {field.options.map((option, optionIndex) => (
                    <div key={optionIndex} className={styles.optionRow}>
                      <Input
                        value={option}
                        maxLength={200}
                        aria-label={t('structure.fields.option', { position: optionIndex + 1 })}
                        onChange={(event) =>
                          dispatch({
                            type: 'updateOption',
                            uid: field.uid,
                            index: optionIndex,
                            value: event.target.value,
                          })
                        }
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={optionIndex === 0}
                        aria-label={t('structure.fields.moveOptionUp')}
                        onClick={() =>
                          dispatch({
                            type: 'moveOption',
                            uid: field.uid,
                            index: optionIndex,
                            delta: -1,
                          })
                        }
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={optionIndex === field.options.length - 1}
                        aria-label={t('structure.fields.moveOptionDown')}
                        onClick={() =>
                          dispatch({
                            type: 'moveOption',
                            uid: field.uid,
                            index: optionIndex,
                            delta: 1,
                          })
                        }
                      >
                        ↓
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('structure.fields.removeOption')}
                        onClick={() =>
                          dispatch({ type: 'removeOption', uid: field.uid, index: optionIndex })
                        }
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                  <div>
                    <Button
                      size="sm"
                      onClick={() => dispatch({ type: 'addOption', uid: field.uid })}
                    >
                      {t('structure.fields.addOption')}
                    </Button>
                  </div>
                  {own.options ? (
                    <p className={styles.alert} role="alert">
                      {errorText(own.options)}
                    </p>
                  ) : null}
                </fieldset>
              ) : null}
              {own.other ? (
                <p className={styles.alert} role="alert">
                  {errorText(own.other)}
                </p>
              ) : null}
              {field.saved &&
              storedTypes?.[field.key] !== undefined &&
              storedTypes[field.key] !== field.type ? (
                <Warning>{t('structure.fields.typeChangeWarning')}</Warning>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
