# Path Intents (for Claude)

The `intent` parameter on path search controls two things at once:
1. **Which paths are returned** (filter)
2. **How they are ranked** (sort)

Forward's network model can produce many paths for a given src/dst — some delivered, some dropped, some violating policy, some looping. `intent` is how you tell the search which of those you care about.

## The three values

### `PREFER_DELIVERED`

- **Returns**: all paths (delivered, dropped, violating).
- **Ranks**: delivered first, then dropped, then violating.
- **Use when**: the user wants to know *whether and how* traffic gets through.
- **Example**: "Can 10.1.2.3 reach 10.5.0.10 on TCP 443?" — you want delivered paths up top.

### `PREFER_VIOLATIONS`

- **Returns**: all paths (delivered, dropped, violating).
- **Ranks**: violating first, then delivered, then dropped.
- **Use when**: the user wants to find issues but still see context.
- **Example**: "Is this flow going through anything it shouldn't?" — violations surface first, but you can still see the delivered paths.

### `VIOLATIONS_ONLY`

- **Returns**: **only** paths that violate at least one policy.
- **Use when**: the user wants a focused audit and doesn't need to see clean paths.
- **Example**: "Show me all policy violations for DMZ → internal traffic" — drop the clean paths entirely.

## Picking the right intent — cheat sheet

| User question shape | Intent |
|---|---|
| "Can X reach Y?" | `PREFER_DELIVERED` |
| "How does traffic flow from X to Y?" | `PREFER_DELIVERED` |
| "Are there issues with this flow?" | `PREFER_VIOLATIONS` |
| "Show me only the problems" | `VIOLATIONS_ONLY` |
| "Security audit / unintended reachability" | `VIOLATIONS_ONLY` |
| No intent specified / unclear | (omit — server default) |

## Anti-patterns

- Don't use `VIOLATIONS_ONLY` when debugging why a legitimate flow fails — you'll miss the *dropped* paths (which aren't violations, they're drops) and the user won't see why traffic doesn't get there.
- Don't assume a delivered path is safe — it may deliver *and* violate policy. When assessing security, always run at least one `PREFER_VIOLATIONS` or `VIOLATIONS_ONLY` pass.
- Don't interpret empty results as "no paths" — check `timedOut` in the response. A short `maxSeconds` budget can return nothing even when paths exist.

## Response interpretation

Regardless of intent, each returned path has a disposition (delivered / dropped / violation). Always inspect the disposition before summarizing to the user — don't count path entries as "successful reachability" just because the query returned results.
