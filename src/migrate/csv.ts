import { usageError } from "../problems.js";

/**
 * RFC 4180 parsing: quoted fields with embedded commas, quotes ("") and line
 * breaks, CRLF, LF or CR rows, and a leading byte order mark. A row of one empty
 * field (a blank line) is skipped. An unclosed quote is an error that names its
 * line, never a silently swallowed rest of the file.
 */
export function parseCsv(text: string, label = "CSV file"): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  let quoteLine = 1;
  const endField = (): void => {
    row.push(field);
    field = "";
    wasQuoted = false;
  };
  const endRow = (): void => {
    const quotedEmpty = wasQuoted;
    endField();
    if (!(row.length === 1 && row[0] === "" && !quotedEmpty)) rows.push(row);
    row = [];
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === "\n") line += 1;
        field += char;
      }
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
      wasQuoted = true;
      quoteLine = line;
    } else if (char === ",") {
      endField();
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      line += 1;
      endRow();
    } else {
      field += char;
    }
  }
  if (quoted) throw usageError(`${label} has a quote opened on line ${quoteLine} that is never closed.`);
  if (field !== "" || row.length > 0 || wasQuoted) endRow();
  return rows;
}

export interface CsvTable {
  /** Header names exactly as written, in column order. */
  header: string[];
  /** One entry per data row: `row` counts records (the header is row 1); values are keyed by canonical column name, undefined when the column is absent. */
  rows: Array<{ row: number; values: Record<string, string | undefined> }>;
}

/**
 * A header-keyed table. `columns` maps each canonical column to the spellings
 * (lower case) it accepts; matching ignores case and surrounding space. Columns
 * the table does not know are ignored. A missing required column is an error
 * naming the spellings that would have worked.
 */
export function csvTable(
  text: string,
  columns: Readonly<Record<string, readonly string[]>>,
  options: { label: string; required?: readonly string[] },
): CsvTable {
  const parsed = parseCsv(text, options.label);
  const header = parsed[0] ?? [];
  const position = new Map<string, number>();
  header.forEach((name, index) => {
    const wanted = name.trim().toLowerCase();
    for (const [canonical, spellings] of Object.entries(columns)) {
      if (!position.has(canonical) && (canonical === wanted || spellings.includes(wanted))) position.set(canonical, index);
    }
  });
  for (const required of options.required ?? []) {
    if (!position.has(required)) {
      throw usageError(`${options.label} needs a ${required} column (${[required, ...(columns[required] ?? [])].join(", ")}); its header row is ${header.map((name) => JSON.stringify(name)).join(", ") || "empty"}.`);
    }
  }
  const rows = parsed.slice(1).map((cells, offset) => {
    const values: Record<string, string | undefined> = {};
    for (const [canonical, index] of position) {
      const cell = cells[index];
      values[canonical] = cell === undefined ? undefined : cell.trim();
    }
    return { row: offset + 2, values };
  });
  return { header, rows };
}
