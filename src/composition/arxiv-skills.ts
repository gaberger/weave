import type { Skill } from "../ports/skill.js";
import { httpFetchTool } from "../adapters/secondary/http-fetch-tool.js";
import { parseArxivAtom, arxivFeedUrl } from "../domain/arxiv.js";

interface FetchOut {
  status: number;
  body?: string;
}

interface DiscoverInputs {
  query?: string;
  feedUrl?: string;
  max?: number;
}

/** arXiv discover (ADR-0008 §4): fetch the feed for a query, parse papers, and spawn one
 *  `arxiv-paper` detail task per paper (subject `arxiv:<id>` → processed once ever via
 *  isSettled dedup). "I found the titles in the daily digest." */
export const arxivDiscoverSkill: Skill = {
  name: "arxiv",
  description: "Discover recent arXiv papers for a query and fan out a detail task per paper.",
  tools: [httpFetchTool],
  match: (t) => t.spec.goal.startsWith("arxiv") || t.spec.goal.startsWith("research arxiv"),
  run: async (t, ctx) => {
    const inputs = (t.spec.inputs ?? {}) as DiscoverInputs;
    const query =
      inputs.query ?? (t.spec.goal.replace(/^(research\s+)?arxiv\s*/i, "").trim() || "large language models");
    const max = inputs.max ?? 10;
    const feedUrl = inputs.feedUrl ?? arxivFeedUrl(query, max);

    ctx.onProgress(`arXiv digest: "${query}"`);
    const res = await ctx.tools.invoke({ name: "http_fetch", args: { target: feedUrl } });
    const out = res.output as FetchOut;
    if (!out.body) {
      return { status: "failed", summary: `arXiv fetch failed (status ${out.status})`, error: "fetch" };
    }

    const papers = parseArxivAtom(out.body);
    ctx.onProgress(`found ${papers.length} papers; fanning out detail tasks`);
    let spawned = 0;
    for (const p of papers) {
      await ctx.tools.invoke({
        name: "spawn_task",
        args: {
          subject: `arxiv:${p.id}`,
          skill: "arxiv-paper",
          goal: p.title,
          inputs: { id: p.id, absUrl: p.absUrl, title: p.title, authors: p.authors, published: p.published },
        },
      });
      spawned += 1;
    }
    return { status: "completed", summary: `arXiv "${query}": ${papers.length} papers, ${spawned} detail task(s) declared` };
  },
};

interface PaperInputs {
  id?: string;
  absUrl?: string;
  title?: string;
  authors?: string[];
  published?: string;
}

/** arXiv paper detail (ADR-0008 §4): fetch the paper's abs page and record its details.
 *  "Let me get the actual paper page with its details." Routed only explicitly (spawned with
 *  skill:"arxiv-paper"), so its match() is false. */
export const arxivPaperSkill: Skill = {
  name: "arxiv-paper",
  description: "Fetch an arXiv paper's page and record its details.",
  tools: [httpFetchTool],
  match: () => false,
  run: async (t, ctx) => {
    const inputs = (t.spec.inputs ?? {}) as PaperInputs;
    const absUrl = inputs.absUrl ?? `https://arxiv.org/abs/${inputs.id ?? ""}`;
    ctx.onProgress(`paper page: ${absUrl}`);
    let pageBytes = 0;
    try {
      const res = await ctx.tools.invoke({ name: "http_fetch", args: { target: absUrl } });
      pageBytes = (res.output as { bytes?: number }).bytes ?? 0;
    } catch {
      /* still record from the feed metadata */
    }
    const paper = {
      id: inputs.id,
      title: inputs.title,
      authors: inputs.authors ?? [],
      published: inputs.published,
      absUrl,
      pageBytes,
    };
    const who = (inputs.authors ?? []).slice(0, 3).join(", ");
    return {
      status: "completed",
      summary: `${inputs.title ?? inputs.id} — ${who}`,
      artifacts: [{ kind: "arxiv-paper", ref: JSON.stringify(paper) }],
    };
  },
};
