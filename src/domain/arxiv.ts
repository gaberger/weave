/** arXiv research domain types + a pragmatic Atom-feed parser (ADR-0008 §4). */

export interface Paper {
  readonly id: string; // arXiv id, e.g. 2406.12345v1
  readonly title: string;
  readonly authors: readonly string[];
  readonly published: string;
  readonly summary: string;
  readonly absUrl: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tag(entry: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry);
  return m?.[1] ? decodeEntities(m[1].trim().replace(/\s+/g, " ")) : "";
}

/** Parse an arXiv API Atom feed into papers. Regex-based — fine for arXiv's regular feed. */
export function parseArxivAtom(xml: string): Paper[] {
  const entries = xml
    .split(/<entry>/)
    .slice(1)
    .map((s) => s.split(/<\/entry>/)[0] ?? "");

  const papers: Paper[] = [];
  for (const e of entries) {
    const absUrl = tag(e, "id");
    const id = absUrl.includes("/abs/") ? (absUrl.split("/abs/")[1] ?? absUrl) : (absUrl.split("/").pop() ?? absUrl);
    const title = tag(e, "title");
    if (!title) continue;
    const authors = [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => decodeEntities((m[1] ?? "").trim()));
    papers.push({
      id,
      title,
      authors,
      published: tag(e, "published"),
      summary: tag(e, "summary"),
      absUrl,
    });
  }
  return papers;
}

/** Build the arXiv API query URL for a free-text query. */
export function arxivFeedUrl(query: string, max: number): string {
  const q = encodeURIComponent(`all:${query}`);
  return `http://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&max_results=${max}`;
}
