/** Intent classifier for learning analytics — categorizes user queries. */

export type Intent = "inventory" | "reachability" | "bgp" | "compliance" | "config" | "security" | "general";

const PATTERNS: Record<Intent, RegExp[]> = {
  inventory: [
    /\b(hosts|devices|inventory|what (do )?(we|you) have?|list (devices|hosts)|show (all )?(devices|hosts))\b/i,
    /\b(topology|map|diagram)\b/i,
  ],
  reachability: [
    /\b(reachable|path|route|trace|can (X|host|device) (reach|get to|talk to))\b/i,
    /\b(connected|linked|adjacent|neighbor)\b/i,
    /\b(hop|tunnel|vlan)\b/i,
  ],
  bgp: [
    /\b(bgp|peer|neighbor|as-path|route (advertise|policy|map))\b/i,
    /\b((ebgp|ibgp)|external|internal)\s*(bgp)?\b/i,
    /\b(route (reflect|target|client))\b/i,
  ],
  compliance: [
    /\b(stig|audit|check|compliance|violation)\b/i,
    /\b(best.?practice|standard)\b/i,
    /\b(cve|vulnerability)\b/i,
  ],
  config: [
    /\b(config|running|show (config|run|version)|interface|startup)\b/i,
    /\b(stanza|section|block)\b/i,
  ],
  general: [], // fallback: no specific patterns
  security: [
    /\b(acl|access.?list|firewall|permit|deny|security)\b/i,
    /\b(authenticate|aaa|login|password|ssh)\b/i,
  ],
};

/**
 * Classify a user utterance into an intent category.
 * Returns the first matching intent, or "general" if none match.
 */
export function classifyIntent(utterance: string): Intent {
  for (const [intent, patterns] of Object.entries(PATTERNS)) {
    if (patterns.some((r) => r.test(utterance))) {
      return intent as Intent;
    }
  }
  return "general";
}

/**
 * Get all patterns for an intent (useful for testing/docs).
 */
export function getIntentPatterns(intent: Intent): RegExp[] {
  return PATTERNS[intent] ?? [];
}