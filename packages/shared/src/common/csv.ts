// CSV writing for the exports (ADR-0009). Pure, so the API writes the files with it and the tests
// pin the escaping. Two concerns:
//
// 1. Quoting (RFC 4180): a cell holding a comma, a double quote, CR or LF is wrapped in double
//    quotes, with each double quote doubled. Lines end with CRLF.
// 2. Formula injection (OWASP "CSV injection"): a spreadsheet runs a cell starting with `=`, `+`,
//    `-`, `@`, tab or CR as a formula. Every TEXT cell starting with one of them gets a leading
//    single quote, which spreadsheets show as text. Finite numbers and booleans are written as
//    they are (a number such as -5 is not a formula); text that looks like a number is still
//    text and still neutralised.
//
// A file starts with a UTF-8 byte order mark so Excel opens Turkish and Arabic text correctly.

/** UTF-8 byte order mark. `Response.text()` strips it: add it back before saving a file. */
export const CSV_BOM = '﻿';
export const CSV_LINE_END = '\r\n';
export const CSV_MIME_TYPE = 'text/csv; charset=utf-8';

/** First characters that make a spreadsheet treat a cell as a formula. */
export const CSV_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'] as const;

export type CsvValue = string | number | boolean | Date | null | undefined;

/** A text value made safe from formula injection (not yet quoted). */
export function neutralizeCsvFormula(text: string): string {
  return CSV_FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix)) ? `'${text}` : text;
}

/** One cell, neutralised and quoted as needed. */
export function csvCell(value: CsvValue): string {
  let text: string;
  if (value === null || value === undefined) {
    text = '';
  } else if (typeof value === 'number') {
    text = Number.isFinite(value) ? String(value) : '';
  } else if (typeof value === 'boolean') {
    text = value ? 'true' : 'false';
  } else if (value instanceof Date) {
    text = Number.isNaN(value.getTime()) ? '' : value.toISOString();
  } else {
    text = neutralizeCsvFormula(value);
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One line, without the line ending. */
export function csvRow(values: readonly CsvValue[]): string {
  return values.map(csvCell).join(',');
}

/** A whole file: the BOM (unless `bom: false`), the header line and the rows, each ending in CRLF. */
export function toCsv(
  header: readonly string[],
  rows: Iterable<readonly CsvValue[]>,
  options: { bom?: boolean } = {},
): string {
  const lines = [csvRow(header)];
  for (const row of rows) {
    lines.push(csvRow(row));
  }
  return `${options.bom === false ? '' : CSV_BOM}${lines.join(CSV_LINE_END)}${CSV_LINE_END}`;
}
