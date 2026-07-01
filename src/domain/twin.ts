/**
 * The twin-graph contract (ADR-0025, Phase-1 follow-on) — the shape of a live network view pushed
 * onto the blackboard.
 *
 * It deliberately reuses the `{ nodes, edges, title }` model the `forward-report-graph` skill already
 * emits (render.py), so a path trace or topology produced by the Forward skills can be piped straight
 * to the canvas (`forward-… | weave twin`) with no reshaping. A `twin.graph` event carries one
 * `TwinGraph`; the blackboard keeps the latest per `view`, so re-publishing a view is a live update.
 */

export const TwinKind = {
  /** A network view (topology or path trace) to render on the blackboard. Latest-per-view wins. */
  Graph: "twin.graph",
} as const;

export interface TwinNode {
  readonly id: string;
  readonly label?: string;
  /** Fill/border hint (e.g. "#e6b23f") — honoured by the canvas if present. */
  readonly color?: string;
  /** Free category the canvas can style/legend by (e.g. "endpoint", "router", "down"). */
  readonly class?: string;
  /** Node status the canvas colours by when no explicit color is given (e.g. "up"|"down"|"warn"). */
  readonly status?: string;
}

export interface TwinEdge {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly color?: string;
  readonly dashed?: boolean;
  readonly status?: string;
}

export interface TwinGraph {
  /** Which named view this replaces on the canvas. Defaults to "twin" (the primary topology). */
  readonly view: string;
  readonly title?: string;
  readonly nodes: readonly TwinNode[];
  readonly edges: readonly TwinEdge[];
}

/** The default view name — a producer that omits `view` updates the single primary topology. */
export const DEFAULT_TWIN_VIEW = "twin";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Validate arbitrary JSON into a `TwinGraph`, failing CLOSED with a specific message. A malformed or
 * partial graph must not reach the canvas as a half-rendered view — the producer (a Forward skill,
 * or a hand-authored file) gets a clear error instead. Unknown fields are dropped; known optionals
 * are kept only when well-typed. Node/edge ids must be strings; an edge to/from an unknown node is
 * allowed (the canvas draws dangling endpoints) but both endpoints must be present strings.
 */
export function parseTwinGraph(input: unknown): TwinGraph {
  if (!isObj(input)) throw new Error("twin graph must be a JSON object with { nodes, edges }");
  const rawNodes = input["nodes"];
  const rawEdges = input["edges"];
  if (!Array.isArray(rawNodes)) throw new Error("twin graph: `nodes` must be an array");
  if (!Array.isArray(rawEdges)) throw new Error("twin graph: `edges` must be an array");

  const nodes: TwinNode[] = rawNodes.map((n, i) => {
    if (!isObj(n)) throw new Error(`twin graph: nodes[${i}] must be an object`);
    const id = str(n["id"]);
    if (!id) throw new Error(`twin graph: nodes[${i}].id must be a non-empty string`);
    const node: TwinNode = { id };
    const label = str(n["label"]); if (label !== undefined) (node as { label?: string }).label = label;
    const color = str(n["color"]); if (color !== undefined) (node as { color?: string }).color = color;
    const cls = str(n["class"]); if (cls !== undefined) (node as { class?: string }).class = cls;
    const status = str(n["status"]); if (status !== undefined) (node as { status?: string }).status = status;
    return node;
  });

  const edges: TwinEdge[] = rawEdges.map((e, i) => {
    if (!isObj(e)) throw new Error(`twin graph: edges[${i}] must be an object`);
    const from = str(e["from"]);
    const to = str(e["to"]);
    if (!from || !to) throw new Error(`twin graph: edges[${i}] needs string \`from\` and \`to\``);
    const edge: TwinEdge = { from, to };
    const label = str(e["label"]); if (label !== undefined) (edge as { label?: string }).label = label;
    const color = str(e["color"]); if (color !== undefined) (edge as { color?: string }).color = color;
    if (typeof e["dashed"] === "boolean") (edge as { dashed?: boolean }).dashed = e["dashed"] as boolean;
    const status = str(e["status"]); if (status !== undefined) (edge as { status?: string }).status = status;
    return edge;
  });

  const view = str(input["view"]) || DEFAULT_TWIN_VIEW;
  const graph: TwinGraph = { view, nodes, edges };
  const title = str(input["title"]);
  if (title !== undefined) (graph as { title?: string }).title = title;
  return graph;
}
