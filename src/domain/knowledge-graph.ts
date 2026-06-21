/**
 * Knowledge-graph model over the OKF report bundle (ADR-0017). Pure: builds nodes/edges from
 * already-extracted per-report facts, and inverts them into forward/back neighbour sets. All I/O
 * (reading concept files, writing graph.json / graph.md, rewriting inline link sections) lives in
 * the composition layer (cli.ts) — this module never touches the filesystem.
 */

export type NodeType = "report" | "source" | "artifact";

export type EdgeType =
  | "task-ref" // report → report: an explicit bundle/markdown/weave://task reference
  | "lineage" // report → report: a parent task spawned the child (causedBy / spawn_task)
  | "co-citation" // report — report: they cite ≥1 of the same external source (undirected)
  | "tag-cluster" // report — report: they share a non-trivial topic tag (undirected)
  | "artifact-ref" // report → artifact: references a local repo/file artifact
  | "cites"; // report → source: cites an external URL

export interface GraphNode {
  readonly id: string; // report: task_id · source: `source:<url>` · artifact: `artifact:<path>`
  readonly type: NodeType;
  readonly label: string;
  readonly skill?: string;
  readonly status?: string;
  readonly timestamp?: string;
  readonly tags?: readonly string[];
  readonly relPath?: string; // report nodes only — bundle-relative path to the concept file
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly type: EdgeType;
  readonly directed: boolean;
  readonly weight?: number; // co-citation / tag-cluster: size of the overlap
}

export interface KnowledgeGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/** Per-report facts extracted from a concept file, the input to {@link buildGraph}. */
export interface ReportInput {
  readonly id: string; // task_id (subject)
  readonly relPath: string; // bundle-relative path
  readonly skill: string;
  readonly status: string;
  readonly timestamp: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly parent?: string; // parent task id (lineage), if any
  readonly links: readonly string[]; // resolved target report ids (explicit refs + weave://task)
  readonly sources: readonly string[]; // external URLs cited
  readonly artifacts: readonly string[]; // local file paths referenced
}

const isTrivialTag = (t: string, skill: string, status: string): boolean => t === skill || t === status;

/** Build the typed multigraph from per-report facts. Report→X edges are directed; the derived
 *  co-citation / tag-cluster relations are undirected. Edges only ever reference known nodes. */
export function buildGraph(reports: readonly ReportInput[]): KnowledgeGraph {
  const byId = new Map(reports.map((r) => [r.id, r]));
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const addNode = (n: GraphNode): void => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };

  for (const r of reports) {
    addNode({ id: r.id, type: "report", label: r.title, skill: r.skill, status: r.status, timestamp: r.timestamp, tags: r.tags, relPath: r.relPath });
  }

  for (const r of reports) {
    for (const target of r.links) {
      if (target !== r.id && byId.has(target)) edges.push({ from: r.id, to: target, type: "task-ref", directed: true });
    }
    if (r.parent && r.parent !== r.id && byId.has(r.parent)) {
      edges.push({ from: r.parent, to: r.id, type: "lineage", directed: true });
    }
    for (const a of r.artifacts) {
      addNode({ id: `artifact:${a}`, type: "artifact", label: a });
      edges.push({ from: r.id, to: `artifact:${a}`, type: "artifact-ref", directed: true });
    }
    for (const s of r.sources) {
      addNode({ id: `source:${s}`, type: "source", label: s });
      edges.push({ from: r.id, to: `source:${s}`, type: "cites", directed: true });
    }
  }

  // Derived undirected relations between report pairs.
  for (let i = 0; i < reports.length; i++) {
    const a = reports[i];
    if (!a) continue;
    for (let j = i + 1; j < reports.length; j++) {
      const b = reports[j];
      if (!b) continue;
      const sharedSources = a.sources.filter((s) => b.sources.includes(s));
      if (sharedSources.length > 0) edges.push({ from: a.id, to: b.id, type: "co-citation", directed: false, weight: sharedSources.length });
      const sharedTags = a.tags.filter((t) => !isTrivialTag(t, a.skill, a.status) && b.tags.includes(t));
      if (sharedTags.length > 0) edges.push({ from: a.id, to: b.id, type: "tag-cluster", directed: false, weight: sharedTags.length });
    }
  }

  return { nodes: [...nodes.values()], edges };
}

export interface Neighbours {
  readonly forward: readonly GraphEdge[]; // edges out of `id` (what it points to)
  readonly back: readonly GraphEdge[]; // directed edges into `id` (what points to it)
  readonly related: readonly GraphEdge[]; // undirected edges touching `id` (co-citation / tag-cluster)
}

/** Forward links, backlinks, and undirected "related" edges for one node. */
export function neighbours(graph: KnowledgeGraph, id: string): Neighbours {
  const forward: GraphEdge[] = [];
  const back: GraphEdge[] = [];
  const related: GraphEdge[] = [];
  for (const e of graph.edges) {
    if (!e.directed) {
      if (e.from === id || e.to === id) related.push(e);
      continue;
    }
    if (e.from === id) forward.push(e);
    if (e.to === id) back.push(e);
  }
  return { forward, back, related };
}
