import { test } from "node:test";
import assert from "node:assert/strict";
import { escHtml, csvCell } from "../src/html.js";

test("escHtml escapes markup and quotes", () => {
  assert.equal(escHtml(`<img src=x onerror="a('b')">&`), "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
  assert.equal(escHtml(null), "");
  assert.equal(escHtml(3), "3");
});

test("csvCell quotes, doubles quotes and defuses formulas", () => {
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("=HYPERLINK(1)"), `"'=HYPERLINK(1)"`);
  assert.equal(csvCell("+64 21"), `"'+64 21"`);
  assert.equal(csvCell("-2"), `"'-2"`);
  assert.equal(csvCell(-2), "-2");
  assert.equal(csvCell(undefined), '""');
});
