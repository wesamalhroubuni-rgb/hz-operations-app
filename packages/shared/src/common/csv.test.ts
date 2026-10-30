import { describe, expect, it } from 'vitest';

import { CSV_BOM, csvCell, csvRow, neutralizeCsvFormula, toCsv } from './csv.js';

describe('csv formula injection', () => {
  it.each(['=1+1', '+1', '-1+2', '@SUM(A1)', '\tcmd', '\rcmd', '=HYPERLINK("http://x")'])(
    'neutralises text starting with a formula character: %j',
    (text) => {
      expect(neutralizeCsvFormula(text)).toBe(`'${text}`);
    },
  );

  it('leaves ordinary text alone', () => {
    expect(neutralizeCsvFormula('Pump 3 checked')).toBe('Pump 3 checked');
    expect(neutralizeCsvFormula(' =not first')).toBe(' =not first');
    expect(neutralizeCsvFormula('')).toBe('');
  });

  it('writes real numbers and booleans unchanged, but neutralises numeric-looking text', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(3.5)).toBe('3.5');
    expect(csvCell(Number.NaN)).toBe('');
    expect(csvCell(true)).toBe('true');
    expect(csvCell('-5')).toBe("'-5");
  });
});

describe('csv quoting', () => {
  it('quotes commas, quotes and line breaks, doubling quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    // Neutralised first, then quoted because of the CR.
    expect(csvCell('\r=1')).toBe(`"'\r=1"`);
    expect(csvCell('=a,b')).toBe(`"'=a,b"`);
  });

  it('writes empty cells for null and undefined, ISO for dates', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(new Date('2026-10-28T11:05:00Z'))).toBe('2026-10-28T11:05:00.000Z');
  });

  it('joins rows and files with CRLF and a BOM', () => {
    expect(csvRow(['a', 1, null, 'x,y'])).toBe('a,1,,"x,y"');
    const file = toCsv(
      ['Name', 'Note'],
      [
        ['Ayşe', '=cmd'],
        ['عامل', 'ok'],
      ],
    );
    expect(file.startsWith(CSV_BOM)).toBe(true);
    expect(file).toBe(`${CSV_BOM}Name,Note\r\nAyşe,'=cmd\r\nعامل,ok\r\n`);
    expect(toCsv(['A'], [], { bom: false })).toBe('A\r\n');
  });
});

/** A strict RFC 4180 reader, to prove the written file reads back cell by cell. */
function readCsv(file: string): string[][] {
  expect(file.startsWith(CSV_BOM)).toBe(true);
  const text = file.slice(CSV_BOM.length);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
        // After a closing quote only a separator or a line end may follow.
        expect([',', '\r']).toContain(text[i + 1]);
      } else {
        cell += char;
      }
    } else if (char === '"') {
      expect(cell).toBe(''); // a quote may only open a cell
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r') {
      expect(text[i + 1]).toBe('\n'); // a bare CR outside quotes would split a record
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else {
      expect(char).not.toBe('\n'); // a bare LF outside quotes would split a record
      cell += char;
    }
  }
  expect(quoted).toBe(false);
  expect(cell).toBe('');
  return rows;
}

describe('csv files read back exactly', () => {
  const HOSTILE = [
    '=1+1',
    '+1',
    '-1',
    '@A1',
    '\tlead tab',
    '\rlead CR',
    '\nlead LF',
    'a,b',
    '"quoted"',
    '""',
    'mid\r\nline',
    'trailing quote"',
    'Ayşe İğdır',
    'عامل في الموقع',
    '👷‍♀️ 🔧',
    '\uFEFFinner BOM',
    '',
    ' =space first',
    '=',
  ];

  it('writes every hostile value as exactly one cell, formulas prefixed with a quote', () => {
    const rows = HOSTILE.map((text, i) => [i, text, -i, null] as const);
    const parsed = readCsv(toCsv(['n', 'text', 'negative', 'empty'], rows));
    expect(parsed).toHaveLength(HOSTILE.length + 1);
    expect(parsed[0]).toEqual(['n', 'text', 'negative', 'empty']);
    for (const [i, text] of HOSTILE.entries()) {
      const formula = /^[=+\-@\t\r]/.test(text);
      expect(parsed[i + 1]).toEqual([String(i), formula ? `'${text}` : text, String(-i), '']);
      expect(parsed[i + 1]![1]).not.toMatch(/^[=+\-@\t\r]/);
    }
  });

  it('neutralises header cells too, and writes one BOM only at the start', () => {
    const file = toCsv(['=evil', 'ok'], [['\uFEFFx', 'y']]);
    expect(file.indexOf(CSV_BOM)).toBe(0);
    expect(readCsv(file)).toEqual([
      ["'=evil", 'ok'],
      ['\uFEFFx', 'y'],
    ]);
  });

  it('writes non-finite numbers and invalid dates as empty cells', () => {
    expect(csvRow([Infinity, -Infinity, new Date('nope'), false])).toBe(',,,false');
  });
});
