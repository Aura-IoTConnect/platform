// Minimal CSV encode/decode for device bulk export/import (see CLAUDE.md's
// "Grouping, tags & bulk import/export" section) — quoted fields, "" for an
// embedded quote, embedded commas/newlines inside quotes, same as what
// Excel/Google Sheets produce and expect. Not a full RFC 4180
// implementation (no configurable delimiter), but there's exactly one
// caller pair (export writes it, import reads it back), so a small
// hand-rolled pair is simpler than a dependency.

export function encodeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function encodeCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((row) => row.map(encodeCsvField).join(",")).join("\r\n") + "\r\n";
}

// Parses a full CSV document into rows of raw string cells — no header
// handling; callers match the first row against known column names
// themselves (encodeCsv's callers do the same in reverse).
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (char === "\r") {
      i += 1;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}
