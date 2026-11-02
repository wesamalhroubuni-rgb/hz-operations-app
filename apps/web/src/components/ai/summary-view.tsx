import type { AnomalyFlag, DailySummary } from '@ops/shared';
import Link from 'next/link';

import { EmptyState } from '@/components/ui/states';
import { Badge } from '@/components/ui/status-badge';
import { formatNumber, t } from '@/i18n';
import {
  anomalyKindLabel,
  anomalyLink,
  anomalyReason,
  severityLabel,
  severityTone,
  summaryKeyNumbers,
  summaryScopeText,
  type ReasonNames,
} from '@/lib/ai';

import styles from './ai.module.css';

// Presentational parts of the daily summaries and unusual items (props only, so they render in
// tests). The narrative is plain text: React escapes it, and nothing in it is interpreted.

export interface SummaryViewProps {
  summary: DailySummary;
  names: ReasonNames;
  formatDay: (day: string) => string;
  formatTime: (value: string) => string;
  /** The heading level of the summary's own title. */
  headingLevel?: 2 | 3;
}

/** One summary: day, who wrote the text, the narrative, the key numbers and the flags. */
export function SummaryView({
  summary,
  names,
  formatDay,
  formatTime,
  headingLevel = 3,
}: Readonly<SummaryViewProps>) {
  const ai = summary.narrativeSource === 'ai';
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const SubHeading = headingLevel === 2 ? 'h3' : 'h4';
  const numbers = summaryKeyNumbers(summary.stats);
  return (
    <article className={styles.panel} aria-labelledby={`summary-${summary.id}`}>
      <div className={styles.panelHead}>
        <Heading id={`summary-${summary.id}`} className={styles.panelTitle}>
          {t('ai.summary.forDay', { day: formatDay(summary.day) })}
        </Heading>
        <Badge
          tone={ai ? 'primary' : 'muted'}
          label={ai ? t('ai.summary.aiWritten') : t('ai.summary.templateWritten')}
        />
      </div>
      <p className={styles.meta}>
        {t('ai.summary.writtenAt', { time: formatTime(summary.createdAt) })}
        {' · '}
        {summaryScopeText(summary)}
      </p>
      <p className={`${styles.narrative} ${ai ? styles.narrativeAi : ''}`} lang={summary.locale}>
        {summary.narrative}
      </p>
      {ai ? <p className={styles.meta}>{t('ai.summary.aiWrittenHint')}</p> : null}
      <section aria-label={t('ai.summary.keyNumbers')}>
        <dl className={styles.numbers}>
          {numbers.map((number) => (
            <div
              key={number.key}
              className={`${styles.number} ${number.attention ? styles.numberAttention : ''}`}
            >
              <dt className={styles.numberLabel}>{number.label}</dt>
              <dd className={styles.numberValue}>{formatNumber(number.value)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-label={t('ai.summary.flagsTitle')}>
        <SubHeading className={styles.panelTitle}>{t('ai.summary.flagsTitle')}</SubHeading>
        {summary.anomalies.length === 0 ? (
          <p className={styles.meta}>{t('ai.summary.noFlags')}</p>
        ) : (
          <AnomalyTable
            flags={summary.anomalies}
            names={names}
            formatDay={formatDay}
            showDay={false}
          />
        )}
      </section>
    </article>
  );
}

export interface AnomalyTableProps {
  flags: readonly AnomalyFlag[];
  names: ReasonNames;
  formatDay: (day: string) => string;
  showDay?: boolean;
  caption?: string;
}

/** Flags as a table: severity (in words, not by colour alone), kind, the reason, the record. */
export function AnomalyTable({
  flags,
  names,
  formatDay,
  showDay = true,
  caption = t('ai.anomalies.caption'),
}: Readonly<AnomalyTableProps>) {
  if (flags.length === 0) {
    return <EmptyState title={t('ai.anomalies.empty')} />;
  }
  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <caption className={styles.visuallyHidden}>{caption}</caption>
        <thead>
          <tr>
            {showDay ? <th scope="col">{t('ai.anomalies.columns.day')}</th> : null}
            <th scope="col">{t('ai.anomalies.columns.severity')}</th>
            <th scope="col">{t('ai.anomalies.columns.kind')}</th>
            <th scope="col">{t('ai.anomalies.columns.reason')}</th>
            <th scope="col">
              <span className={styles.visuallyHidden}>{t('ai.anomalies.columns.link')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {flags.map((flag) => {
            const link = anomalyLink(flag);
            return (
              <tr key={flag.id}>
                {showDay ? <td>{formatDay(flag.day)}</td> : null}
                <td>
                  <Badge tone={severityTone(flag.severity)} label={severityLabel(flag.severity)} />
                </td>
                <th scope="row">{anomalyKindLabel(flag.kind)}</th>
                <td>{anomalyReason(flag, names)}</td>
                <td>
                  {link ? (
                    <Link href={link.href} className={styles.link}>
                      {link.label}
                    </Link>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
