/** Pure model-tier classifier (ADR-0022). Maps a goal to a coarse complexity tier so the composition
 *  layer can route it to a cheap/mid/frontier model. No deps, deterministic, testable — the *policy*
 *  of which tier a goal gets; the tier→model id map lives in composition (the harness stays
 *  domain-agnostic, ADR-0016). */

/** 1 = cheapest/fastest, 3 = most capable. */
export type Tier = 1 | 2 | 3;

/** Hard-reasoning signals → frontier tier. Matched as word-prefixes so "architecture", "migration",
 *  "analyze"/"analyse", "optimize"/"optimise", "vulnerability" all hit. */
const FRONTIER =
  /\b(architect|architecture|design|audit|security|secure|threat|migrat|refactor|prove|proof|reason|analy[sz]|investigat|debug|root.?cause|optim[ai]|vulnerab|cve|compliance|exploit|consensus|protocol)/i;

/** Pure conversational openers → cheapest tier regardless of length. */
const CHATTY = /^(hi|hey|hello|yo|thanks|thank you|ok|okay|cool|nice|sup|ping|good (morning|afternoon|evening))\b/i;

/**
 * Classify a goal into a model tier. Frontier keywords win first; then short/conversational goals
 * fall to the cheap tier; everything else gets the safe default (tier 2). Conservative by design:
 * anything ambiguous stays at tier 2, matching weave's current default model.
 */
export function classifyTier(goal: string, shortWords = 8): Tier {
  const g = goal.trim();
  if (!g) return 2;
  if (FRONTIER.test(g)) return 3;
  const words = g.split(/\s+/).length;
  if (CHATTY.test(g) || words <= shortWords) return 1;
  return 2;
}
