import { describe, expect, it } from "vitest";
import { encodeCsv, encodeCsvField, parseCsv } from "../src/csv.js";

describe("encodeCsvField", () => {
  it("leaves plain values alone", () => {
    expect(encodeCsvField("plain")).toBe("plain");
    expect(encodeCsvField("")).toBe("");
    expect(encodeCsvField("with space")).toBe("with space");
  });

  it("quotes values containing a comma, quote, or newline, doubling embedded quotes", () => {
    expect(encodeCsvField("a,b")).toBe('"a,b"');
    expect(encodeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(encodeCsvField("line1\nline2")).toBe('"line1\nline2"');
    expect(encodeCsvField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
});

describe("encodeCsv", () => {
  it("emits CRLF-terminated rows with a trailing newline", () => {
    expect(encodeCsv(["a", "b"], [["1", "2"]])).toBe("a,b\r\n1,2\r\n");
  });

  it("with no rows still emits the header", () => {
    expect(encodeCsv(["a", "b"], [])).toBe("a,b\r\n");
  });
});

describe("parseCsv", () => {
  it("parses plain rows", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("accepts CRLF and a missing trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps commas, doubled quotes and newlines inside quoted fields", () => {
    expect(parseCsv('"a,b","say ""hi""","l1\nl2"\n')).toEqual([["a,b", 'say "hi"', "l1\nl2"]]);
  });

  it("preserves empty fields, including a trailing one", () => {
    expect(parseCsv("a,,c\n")).toEqual([["a", "", "c"]]);
    expect(parseCsv("a,b,\n")).toEqual([["a", "b", ""]]);
  });

  it("drops blank lines", () => {
    expect(parseCsv("a\n\n\nb\n")).toEqual([["a"], ["b"]]);
  });

  it("returns no rows for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("does not throw on an unterminated quote — the rest becomes one field", () => {
    expect(() => parseCsv('a,"unterminated\nstill going')).not.toThrow();
    expect(parseCsv('a,"oops')).toEqual([["a", "oops"]]);
  });
});

describe("encode -> parse round trip", () => {
  it("survives awkward values unchanged", () => {
    const header = ["name", "notes"];
    const rows = [
      ["plain", "nothing special"],
      ["comma, inside", 'quote " inside'],
      ["multi\nline", "  leading and trailing spaces  "],
      ["unicode ✓ é 日本", ""],
      ["", ""],
    ];
    const parsed = parseCsv(encodeCsv(header, rows));

    expect(parsed[0]).toEqual(header);
    // Even the all-empty row survives: with two columns it encodes as ",",
    // which is a real row, not a blank line.
    expect(parsed.slice(1)).toEqual(rows);
  });

  it("known limit: a single-column row holding an empty string is indistinguishable from a blank line and is dropped", () => {
    expect(parseCsv(encodeCsv(["only"], [["a"], [""], ["b"]]))).toEqual([["only"], ["a"], ["b"]]);
  });
});
