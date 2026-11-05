// Перевод гайда из Markdown в HTML для окна «Как играть».
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { markdownToHtml } from "../scripts/apps/markdown.mjs";

test("headings, lists, inline", () => {
  const html = markdownToHtml("# A\n\nText **b** and `c<d>`.\n\n- one\n- two\n\n1. x\n2. y");
  assert.equal(html, "<h1>A</h1>\n<p>Text <strong>b</strong> and <code>c&lt;d&gt;</code>.</p>\n<ul><li>one</li><li>two</li></ul>\n<ol><li>x</li><li>y</li></ol>");
});

test("tables and list continuation", () => {
  const html = markdownToHtml("| a | b |\n|---|---|\n| 1 | 2 |\n\n1. first\n   more");
  assert.equal(html, "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>\n<ol><li>first more</li></ol>");
});

test("guide renders without raw markdown", () => {
  const html = markdownToHtml(readFileSync(new URL("../docs/GUIDE.md", import.meta.url), "utf8"));
  assert.ok(html.includes("<table>"));
  assert.ok(!/\*\*|^#/m.test(html));
});
