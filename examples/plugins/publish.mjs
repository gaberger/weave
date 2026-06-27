// Example CODE skill (deterministic, no LLM) -- publish a directory of markdown reports into a
// single PDF (+ HTML) "book". Drop into .weave/skills/. Default-exports a Skill object:
//   { name, description, match, run }
// Renders markdown to HTML with a self-contained template, then prints to PDF via headless Chrome
// (no pandoc/LaTeX needed). Dependency-free: imports only node builtins, so it runs unchanged when
// dropped into any weave home. Pairs with the multi-agent research recipe -- fan out section tasks,
// synthesize, then `weave task --skill publish "...<reports-dir>..."` to bind it all into one doc.
//
// Usage:  weave task --skill publish "publish the reports in <abs-dir> as a PDF book"
// The source dir is the first existing absolute path token in the goal, else
// <WEAVE_HOME>/reports/diffusion. Output: <dir>/<name>.pdf and <dir>/<name>.html.

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, isAbsolute, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

// ---------- minimal, deterministic markdown -> html ----------
// Scoped to the constructs reports use: ATX headings, GFM tables, fenced code, blockquotes,
// ordered/unordered lists, hr, links, **bold**, *italic*, `code`. Underscore emphasis is NOT
// supported on purpose -- math-heavy text is full of subscripts (p_theta, x_t) it would mangle.

// A NUL byte: a sentinel that cannot appear in markdown source, so stashing code spans behind it
// never collides with natural numbers in the prose (e.g. years like "2020") on restore.
const NUL = String.fromCharCode(0);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const slug = (s) => s.toLowerCase().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

function inline(text) {
  const codes = [];
  let t = text.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c);
    return NUL + (codes.length - 1) + NUL;
  });
  t = esc(t);
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => `<a href="${url}">${label}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(new RegExp(NUL + "(\\d+)" + NUL, "g"), (_m, i) => `<code>${esc(codes[+i])}</code>`);
  return t;
}

const isSep = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes("-");

function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let firstHeading = null;
  let i = 0;
  const blockStart = /^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+\.\s|\s*>)/;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      i++;
      const buf = [];
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      html += `<pre><code>${esc(buf.join("\n"))}</code></pre>\n`;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isSep(lines[i + 1])) {
      const row = (r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const header = row(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") body.push(row(lines[i++]));
      html += "<table><thead><tr>" + header.map((h) => `<th>${inline(h)}</th>`).join("") + "</tr></thead><tbody>";
      for (const r of body) html += "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
      html += "</tbody></table>\n";
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      if (!firstHeading) firstHeading = text;
      html += `<h${level} id="${slug(text)}">${inline(text)}</h${level}>\n`;
      i++;
      continue;
    }

    if (/^\s*([-*_])\1\1+\s*$/.test(line)) {
      html += "<hr/>\n";
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      html += `<blockquote>${inline(buf.join(" "))}</blockquote>\n`;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*[-*+]\s+/, ""));
      html += "<ul>" + buf.map((b) => `<li>${inline(b)}</li>`).join("") + "</ul>\n";
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*\d+\.\s+/, ""));
      html += "<ol>" + buf.map((b) => `<li>${inline(b)}</li>`).join("") + "</ol>\n";
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !blockStart.test(lines[i]) && !lines[i].includes("|")) {
      buf.push(lines[i++]);
    }
    html += `<p>${inline(buf.join(" "))}</p>\n`;
  }

  return { html, firstHeading };
}

const CSS = `
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  @page { margin: 22mm 18mm; }
  html { font-family: Georgia, "Times New Roman", serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; }
  body { margin: 0; }
  h1, h2, h3, h4 { font-family: "Helvetica Neue", Arial, sans-serif; line-height: 1.25; color: #111; }
  h1 { font-size: 22pt; margin: 0 0 .4em; }
  h2 { font-size: 16pt; margin: 1.4em 0 .4em; border-bottom: 2px solid #e2e2e2; padding-bottom: .15em; }
  h3 { font-size: 13pt; margin: 1.1em 0 .3em; }
  p { margin: .55em 0; }
  a { color: #0b5; text-decoration: none; }
  code { font-family: "SF Mono", Menlo, monospace; font-size: .88em; background: #f3f3f3; padding: .08em .3em; border-radius: 3px; }
  pre { background: #f7f7f7; border: 1px solid #e2e2e2; border-radius: 6px; padding: .8em 1em; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: .6em 0; padding: .3em 1em; border-left: 3px solid #bdbdbd; background: #fafafa; font-style: italic; }
  table { border-collapse: collapse; width: 100%; margin: .8em 0; font-size: .9em; font-family: "Helvetica Neue", Arial, sans-serif; }
  th, td { border: 1px solid #d8d8d8; padding: .4em .6em; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; }
  hr { border: none; border-top: 1px solid #e2e2e2; margin: 1.4em 0; }
  .titlepage { text-align: center; padding-top: 30vh; page-break-after: always; }
  .titlepage .t { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 30pt; font-weight: 700; }
  .titlepage .s { color: #666; margin-top: .6em; font-size: 13pt; }
  .titlepage .m { color: #999; margin-top: 3em; font-size: 10pt; }
  nav.toc { page-break-after: always; }
  nav.toc h2 { border: none; }
  nav.toc ol { font-family: "Helvetica Neue", Arial, sans-serif; line-height: 1.9; }
  section.file { page-break-before: always; }
  section.file:first-of-type { page-break-before: avoid; }
`;

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("no Chrome/Chromium found (set CHROME_PATH)");
}

export default {
  name: "publish",
  description: "Render a directory of markdown reports into a single PDF (+ HTML) book via headless Chrome.",
  match: (task) =>
    task?.spec?.skill === "publish" || /\b(publish|pdf|book)\b/i.test(task?.spec?.goal ?? ""),

  async run(task, ctx) {
    const goal = task?.spec?.goal ?? "";
    const note = (n) => ctx?.onProgress?.(n);

    // Resolve the source directory: first existing absolute path token in the goal, else default.
    let srcDir = "";
    for (const tok of goal.split(/\s+/)) {
      const clean = tok.replace(/[.,;:)"']+$/, "");
      if (isAbsolute(clean) && existsSync(clean) && statSync(clean).isDirectory()) {
        srcDir = clean;
        break;
      }
    }
    if (!srcDir) {
      const home = process.env.WEAVE_HOME || process.cwd();
      srcDir = join(home, "reports", "diffusion");
    }
    if (!existsSync(srcDir)) {
      return { status: "failed", summary: `publish: source dir not found: ${srcDir}`, error: "ENOENT" };
    }

    const mdFiles = readdirSync(srcDir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .sort(); // 00-SURVEY first, then 01..NN
    if (mdFiles.length === 0) {
      return { status: "failed", summary: `publish: no .md files in ${srcDir}`, error: "empty" };
    }
    note(`publish: ${mdFiles.length} markdown file(s) in ${srcDir}`);

    // Render each file; collect a TOC entry from each file's first heading.
    const toc = [];
    let bodyHtml = "";
    let docTitle = "";
    for (const f of mdFiles) {
      const md = readFileSync(join(srcDir, f), "utf8");
      const { html, firstHeading } = mdToHtml(md);
      const id = `file-${slug(f.replace(/\.md$/i, ""))}`;
      const title = firstHeading || f;
      if (!docTitle) docTitle = title; // first file's H1 becomes the book title
      toc.push({ id, title });
      bodyHtml += `<section class="file" id="${id}">\n${html}\n</section>\n`;
    }

    const tocHtml =
      `<nav class="toc"><h2>Contents</h2><ol>` +
      toc.map((e) => `<li><a href="#${e.id}">${esc(e.title)}</a></li>`).join("") +
      `</ol></nav>`;

    const title = esc(docTitle || basename(srcDir));
    const fullHtml =
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head><body>` +
      `<div class="titlepage"><div class="t">${title}</div>` +
      `<div class="s">Compiled from ${mdFiles.length} section reports</div>` +
      `<div class="m">Generated by weave &middot; publish skill</div></div>` +
      tocHtml +
      bodyHtml +
      `</body></html>`;

    const base = basename(srcDir);
    const htmlPath = join(srcDir, `${base}.html`);
    const pdfPath = join(srcDir, `${base}.pdf`);
    writeFileSync(htmlPath, fullHtml);
    note(`publish: wrote HTML (${(fullHtml.length / 1024).toFixed(0)} KB) -> ${htmlPath}`);

    // Print to PDF via headless Chrome, isolated profile so a running Chrome isn't disturbed.
    let pdfNote = "";
    try {
      const chrome = findChrome();
      const profile = join(tmpdir(), `weave-chrome-${process.pid}-${Date.now()}`);
      mkdirSync(profile, { recursive: true });
      note("publish: printing PDF via headless Chrome...");
      execFileSync(
        chrome,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          `--user-data-dir=${profile}`,
          "--no-pdf-header-footer",
          "--run-all-compositor-stages-before-draw",
          "--virtual-time-budget=20000",
          `--print-to-pdf=${pdfPath}`,
          pathToFileURL(htmlPath).href,
        ],
        { stdio: "pipe", timeout: 90_000 },
      );
    } catch (e) {
      pdfNote = e instanceof Error ? e.message : String(e);
    }

    if (existsSync(pdfPath)) {
      const kb = (statSync(pdfPath).size / 1024).toFixed(0);
      return {
        status: "completed",
        summary: `Published ${mdFiles.length} sections -> ${pdfPath} (${kb} KB) and ${htmlPath}`,
        artifacts: [
          { kind: "pdf", ref: pdfPath },
          { kind: "html", ref: htmlPath },
        ],
      };
    }
    // PDF step failed but HTML is a usable deliverable -- report completed, surface the cause.
    return {
      status: "completed",
      summary: `Wrote HTML book -> ${htmlPath}; PDF step did not produce a file${pdfNote ? `: ${pdfNote}` : ""}`,
      artifacts: [{ kind: "html", ref: htmlPath }],
    };
  },
};
