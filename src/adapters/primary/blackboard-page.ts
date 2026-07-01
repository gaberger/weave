/**
 * The blackboard page (ADR-0025) — a self-contained single-file HTML/JS surface served at `GET /` by
 * the SSE adapter. It connects to `/events` via EventSource and renders three live panels from the
 * one substrate stream:
 *   1. TWIN — a spatial network view (the "hologram"): a hand-rolled force-directed topology folded
 *      from `twin.graph` events (latest per view), the `forward-report-graph` {nodes,edges} shape.
 *   2. TASKS — a grid of task state folded per subject from the task.* lifecycle events.
 *   3. FEED — the raw event stream.
 * No build step, no deps — vanilla JS + SVG, in the spirit of forward-report-graph's self-contained
 * output. Kept as a TS string (not a .html asset) so `bun build --compile` bundles it into the binary.
 */
export const BLACKBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>weave · blackboard</title>
<style>
  :root {
    --bg:#05080d; --panel:#0a1119; --line:#16222e; --ink:#c7d6e0; --dim:#5b7286;
    --cyan:#3fd0e6; --amber:#e6b23f; --green:#4fd18a; --red:#ff5c72; --violet:#a98bff;
    --glow:0 0 12px;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; }
  body {
    background:radial-gradient(1200px 700px at 70% -10%, #0b1826 0%, var(--bg) 60%);
    color:var(--ink); font:13px/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    display:flex; flex-direction:column; height:100vh; overflow:hidden;
  }
  header {
    display:flex; align-items:center; gap:14px; padding:10px 16px;
    border-bottom:1px solid var(--line); background:linear-gradient(180deg,#0a1420,#070d14);
  }
  .brand { font-weight:600; letter-spacing:.14em; color:var(--cyan); text-shadow:var(--glow) rgba(63,208,230,.5); }
  .brand small { color:var(--dim); font-weight:400; letter-spacing:.08em; margin-left:6px; }
  .spacer { flex:1; }
  .stat { color:var(--dim); }
  .stat b { color:var(--ink); font-weight:600; }
  .dot { width:9px; height:9px; border-radius:50%; display:inline-block; margin-right:6px; vertical-align:middle; }
  .dot.on  { background:var(--green); box-shadow:var(--glow) var(--green); animation:pulse 2s infinite; }
  .dot.off { background:var(--red);   box-shadow:var(--glow) var(--red); }
  .dot.wait{ background:var(--amber); box-shadow:var(--glow) var(--amber); }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  main { flex:1; display:flex; flex-direction:column; min-height:0; }
  .lower { flex:1; display:grid; grid-template-columns:1.3fr 1fr; gap:1px; background:var(--line); min-height:0; }
  section { background:var(--panel); display:flex; flex-direction:column; min-height:0; }
  #twin { flex:1.35; border-bottom:1px solid var(--line); min-height:0; }
  .head { padding:8px 14px; color:var(--dim); text-transform:uppercase; letter-spacing:.12em; font-size:11px;
          border-bottom:1px solid var(--line); display:flex; align-items:center; gap:10px; }
  .head .title { color:var(--cyan); text-transform:none; letter-spacing:normal; }
  .head .views { margin-left:auto; display:flex; gap:6px; }
  .head .views button { font:inherit; font-size:10px; color:var(--dim); background:#0b141d;
      border:1px solid var(--line); border-radius:4px; padding:1px 7px; cursor:pointer; }
  .head .views button.active { color:var(--cyan); border-color:var(--cyan); }
  .body { flex:1; overflow:auto; padding:10px; }
  /* twin canvas */
  #twinwrap { flex:1; position:relative; min-height:0; }
  #svg { width:100%; height:100%; display:block; }
  #twinempty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--dim); }
  .edge { stroke:#2a4356; stroke-width:1.4; }
  .edge.hot { stroke:var(--cyan); stroke-width:2.2; filter:drop-shadow(0 0 4px rgba(63,208,230,.7)); }
  .edge.down { stroke:var(--red); }
  .elabel { fill:var(--dim); font-size:9px; }
  .node circle { stroke:#0a1119; stroke-width:2; }
  .node text { fill:var(--ink); font-size:10px; text-anchor:middle; paint-order:stroke;
               stroke:#05080d; stroke-width:3px; }
  /* task grid */
  #tasks { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:9px; align-content:start; }
  .card { border:1px solid var(--line); border-left:3px solid var(--dim); border-radius:7px;
          padding:8px 10px; background:#0b141d; transition:border-color .3s, box-shadow .3s; }
  .card.claimed  { border-left-color:var(--violet); box-shadow:var(--glow) rgba(169,139,255,.15); }
  .card.running  { border-left-color:var(--cyan);   box-shadow:var(--glow) rgba(63,208,230,.18); }
  .card.completed{ border-left-color:var(--green); }
  .card.failed   { border-left-color:var(--red);   box-shadow:var(--glow) rgba(255,92,114,.18); }
  .card.cancelled{ border-left-color:var(--amber); opacity:.7; }
  .card .id { color:var(--cyan); font-weight:600; }
  .card .badge { float:right; font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--dim); }
  .card.running  .badge { color:var(--cyan); } .card.completed .badge { color:var(--green); }
  .card.failed   .badge { color:var(--red); } .card.claimed  .badge { color:var(--violet); }
  .card .goal { margin:5px 0; color:var(--ink); overflow:hidden; text-overflow:ellipsis;
                display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
  .card .meta { color:var(--dim); font-size:11px; }
  .card .note { color:var(--amber); font-size:11px; margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .empty { color:var(--dim); padding:24px; text-align:center; }
  /* feed */
  #feed { font-size:12px; }
  .ev { display:flex; gap:8px; padding:2px 4px; border-radius:4px; white-space:nowrap; }
  .ev:hover { background:#0d1a26; }
  .ev .seq { color:var(--dim); min-width:44px; text-align:right; }
  .ev .k   { min-width:150px; }
  .ev .who { color:var(--dim); min-width:88px; overflow:hidden; text-overflow:ellipsis; }
  .ev .sub { color:var(--ink); overflow:hidden; text-overflow:ellipsis; }
  .ev.declared .k{color:var(--dim)} .ev.claimed .k{color:var(--violet)} .ev.progress .k{color:var(--cyan)}
  .ev.completed .k{color:var(--green)} .ev.failed .k{color:var(--red)} .ev.tool .k{color:var(--amber)}
  .ev.learning .k{color:var(--violet)} .ev.cancel .k{color:var(--amber)} .ev.released .k{color:var(--dim)}
  .ev.twin .k{color:var(--green)}
</style>
</head>
<body>
<header>
  <span class="brand">◇ WEAVE<small>blackboard</small></span>
  <span class="spacer"></span>
  <span class="stat"><span id="dot" class="dot wait"></span><span id="conn">connecting…</span></span>
  <span class="stat">tasks <b id="ntasks">0</b></span>
  <span class="stat">events <b id="nev">0</b></span>
</header>
<main>
  <section id="twin">
    <div class="head">twin <span class="title" id="twintitle"></span><span class="views" id="views"></span></div>
    <div id="twinwrap">
      <svg id="svg" viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid meet"></svg>
      <div id="twinempty">waiting for a twin view…  ·  publish one with <code style="color:var(--cyan)">&nbsp;weave twin&nbsp;</code></div>
    </div>
  </section>
  <div class="lower">
    <section>
      <div class="head">tasks</div>
      <div class="body"><div id="tasks"></div><div id="tempty" class="empty">waiting for the first task…</div></div>
    </section>
    <section>
      <div class="head">event stream</div>
      <div class="body"><div id="feed"></div></div>
    </section>
  </div>
</main>
<script>
(function () {
  var FEED_MAX = 300, W = 1000, H = 600;
  var SVGNS = "http://www.w3.org/2000/svg";
  var tasks = new Map();          // subject -> task state
  var views = new Map();          // view name -> {title, nodes, edges}
  var active = null;              // currently rendered view name
  var sim = { nodes: [], edges: [], pos: new Map() }; // pos persists across updates by node id
  var nev = 0;
  var qs = new URLSearchParams(location.search);
  var url = "/events" + (qs.get("secret") ? "?secret=" + encodeURIComponent(qs.get("secret")) : "");

  var $ = function (id) { return document.getElementById(id); };
  // Escape for element + attribute contexts — event fields (goal/label/title) are untrusted text.
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]; }); };

  // ---- twin: fold + force-directed layout -------------------------------------------------------
  function statusColor(o, fallback) {
    if (o.color) return o.color;
    var s = (o.status || o["class"] || "").toLowerCase();
    if (s === "down" || s === "fail" || s === "dropped") return "var(--red)";
    if (s === "warn" || s === "degraded") return "var(--amber)";
    if (s === "up" || s === "ok") return "var(--green)";
    if (s === "endpoint") return "var(--cyan)";
    return fallback;
  }
  function foldTwin(view, g) {
    views.set(view, { title: g.title || "", nodes: g.nodes || [], edges: g.edges || [] });
    active = view; // newest-updated view becomes the focus
    rebuildViews();
    rebuildSim();
  }
  function rebuildViews() {
    var el = $("views");
    el.innerHTML = "";
    if (views.size <= 1) return;
    Array.from(views.keys()).forEach(function (name) {
      var b = document.createElement("button");
      b.textContent = name; if (name === active) b.className = "active";
      b.onclick = function () { active = name; rebuildViews(); rebuildSim(); };
      el.appendChild(b);
    });
  }
  function rebuildSim() {
    var g = views.get(active);
    $("twinempty").style.display = g && g.nodes.length ? "none" : "flex";
    $("twintitle").textContent = g && g.title ? g.title : "";
    if (!g) { sim = { nodes: [], edges: [], pos: sim.pos }; return; }
    var nodes = g.nodes.map(function (n, i) {
      var p = sim.pos.get(n.id);
      if (!p) { // deterministic spiral seed (no RNG) so layout is stable across reloads
        var a = i * 2.399963, r = 60 + i * 9;
        p = { x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r, vx: 0, vy: 0 };
        sim.pos.set(n.id, p);
      }
      return { id: n.id, label: n.label || n.id, color: statusColor(n, "#2b7fa8"), p: p };
    });
    var ids = new Set(nodes.map(function (n) { return n.id; }));
    var edges = g.edges.filter(function (e) { return ids.has(e.from) && ids.has(e.to); })
      .map(function (e) { return { from: e.from, to: e.to, label: e.label || "",
        cls: (e.status || "").toLowerCase() === "down" ? "down" : (e.status || e.color ? "hot" : ""),
        dashed: !!e.dashed }; });
    sim = { nodes: nodes, edges: edges, pos: sim.pos };
    energize();
  }

  // One physics step: pairwise repulsion + edge springs + gentle centering, with damping.
  // Numerically hardened: a distance FLOOR (nodes never sit at d=0), a repulsion CAP, and a velocity
  // CAP — without these a close pair makes 1/d² explode, velocities run to Infinity, and positions go
  // NaN (which renders as a collapsed blob). A tiny per-node jitter breaks exact overlaps.
  var VCAP = 22, DMIN = 6;
  function step() {
    var ns = sim.nodes; if (!ns.length) return 0;
    var pos = {}; ns.forEach(function (n) { pos[n.id] = n.p; });
    for (var i = 0; i < ns.length; i++) for (var j = i + 1; j < ns.length; j++) {
      var a = ns[i].p, b = ns[j].p, dx = a.x - b.x, dy = a.y - b.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < DMIN) { dx += (i - j); dy += (j - i); d = Math.max(DMIN, Math.sqrt(dx * dx + dy * dy)); } // unstick exact overlaps
      var f = Math.min(40, 9000 / (d * d)), ux = dx / d, uy = dy / d;
      a.vx += ux * f; a.vy += uy * f; b.vx -= ux * f; b.vy -= uy * f;
    }
    sim.edges.forEach(function (e) {
      var a = pos[e.from], b = pos[e.to]; if (!a || !b) return;
      var dx = b.x - a.x, dy = b.y - a.y, d = Math.max(DMIN, Math.sqrt(dx * dx + dy * dy));
      var f = (d - 150) * 0.02, ux = dx / d, uy = dy / d;
      a.vx += ux * f; a.vy += uy * f; b.vx -= ux * f; b.vy -= uy * f;
    });
    var ke = 0, clamp = function (v) { return v < -VCAP ? -VCAP : v > VCAP ? VCAP : v; };
    ns.forEach(function (n) {
      var p = n.p; // velocity lives on p (the force loops mutate n.p.vx via a=ns[i].p) — use it here too
      p.vx += (W / 2 - p.x) * 0.004; p.vy += (H / 2 - p.y) * 0.004; // centering gravity
      p.vx = clamp(p.vx * 0.85); p.vy = clamp(p.vy * 0.85);         // damping + hard velocity cap
      p.x += p.vx; p.y += p.vy;
      p.x = Math.max(24, Math.min(W - 24, p.x)); p.y = Math.max(24, Math.min(H - 24, p.y));
      ke += p.vx * p.vx + p.vy * p.vy;
    });
    return ke;
  }
  var running = false;
  function energize() { if (!running) { running = true; requestAnimationFrame(loop); } }
  function loop() {
    var ke = 0; for (var k = 0; k < 2; k++) ke = step(); // 2 substeps/frame settles faster
    renderTwin();
    if (ke > 0.05 && sim.nodes.length) requestAnimationFrame(loop); else running = false;
  }
  function renderTwin() {
    var svg = $("svg"), pos = {}; sim.nodes.forEach(function (n) { pos[n.id] = n.p; });
    var out = "";
    sim.edges.forEach(function (e) {
      var a = pos[e.from], b = pos[e.to]; if (!a || !b) return;
      out += '<line class="edge ' + e.cls + '" x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) +
             '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '"' +
             (e.dashed ? ' stroke-dasharray="5 4"' : '') + ' />';
      if (e.label) out += '<text class="elabel" x="' + ((a.x + b.x) / 2).toFixed(1) + '" y="' +
             ((a.y + b.y) / 2 - 3).toFixed(1) + '">' + esc(e.label) + '</text>';
    });
    sim.nodes.forEach(function (n) {
      var r = Math.min(26, 13 + n.label.length);
      out += '<g class="node"><circle cx="' + n.p.x.toFixed(1) + '" cy="' + n.p.y.toFixed(1) +
             '" r="' + r + '" fill="' + esc(n.color) + '" /><text x="' + n.p.x.toFixed(1) + '" y="' +
             (n.p.y + 3.5).toFixed(1) + '">' + esc(n.label) + '</text></g>';
    });
    svg.innerHTML = out;
  }

  // ---- tasks + feed -----------------------------------------------------------------------------
  function kindClass(kind) {
    if (kind === "task.declared") return "declared"; if (kind === "task.claimed") return "claimed";
    if (kind === "task.progress") return "progress"; if (kind === "task.completed") return "completed";
    if (kind === "task.failed") return "failed"; if (kind === "task.released") return "released";
    if (kind === "task.cancel") return "cancel"; if (kind === "tool.invoked") return "tool";
    if (kind === "twin.graph") return "twin";
    if (kind && kind.indexOf("learning.") === 0) return "learning";
    return "";
  }
  function fold(e) {
    if (!e.kind || e.kind.indexOf("task.") !== 0) return;
    var t = tasks.get(e.subject) || { goal:"", skill:"", owner:"", note:"", err:"", state:"declared" };
    var p = e.payload || {};
    switch (e.kind) {
      case "task.declared": t.state="declared"; t.goal=(p.spec&&p.spec.goal)||p.goal||t.goal; t.skill=(p.spec&&p.spec.skill)||t.skill; break;
      case "task.claimed":  t.state="claimed"; t.owner=e.actor; break;
      case "task.progress": t.state="running"; if (p.note) t.note=p.note; break;
      case "task.completed":t.state="completed"; break;
      case "task.failed":   t.state="failed"; t.err=(p.error||"").split("\n")[0]; break;
      case "task.released": if (t.state!=="completed"&&t.state!=="failed") t.state="declared"; break;
      case "task.cancel":   t.state="cancelled"; break;
    }
    t.seq=e.seq; tasks.set(e.subject, t);
  }
  function renderTasks() {
    var el = $("tasks"), entries = Array.from(tasks.entries());
    $("tempty").style.display = entries.length ? "none" : "block";
    var rank = { running:0, claimed:1, declared:2, failed:3, completed:4, cancelled:5 };
    entries.sort(function (a, b) { var d = rank[a[1].state]-rank[b[1].state]; return d!==0?d:b[1].seq-a[1].seq; });
    el.innerHTML = entries.map(function (kv) { var id=kv[0], t=kv[1];
      return '<div class="card '+t.state+'"><span class="badge">'+t.state+'</span><span class="id">'+esc(id)+'</span>'+
        '<div class="goal">'+(esc(t.goal)||'<span style="color:var(--dim)">—</span>')+'</div>'+
        '<div class="meta">'+(t.skill?esc(t.skill)+' · ':'')+(t.owner?'@'+esc(t.owner):'unclaimed')+'</div>'+
        (t.state==="failed"&&t.err?'<div class="note" style="color:var(--red)">'+esc(t.err)+'</div>'
          :(t.note?'<div class="note">'+esc(t.note)+'</div>':''))+'</div>';
    }).join("");
    $("ntasks").textContent = entries.length;
  }
  function pushFeed(e) {
    var feed = $("feed"), row = document.createElement("div");
    row.className = "ev " + kindClass(e.kind);
    var extra = "";
    if (e.kind === "task.progress" && e.payload && e.payload.note) extra = " — " + e.payload.note;
    else if (e.kind === "task.failed" && e.payload && e.payload.error) extra = " — " + String(e.payload.error).split("\n")[0];
    else if (e.kind === "twin.graph" && e.payload) extra = " — " + ((e.payload.nodes||[]).length) + " nodes";
    row.innerHTML = '<span class="seq">#'+e.seq+'</span><span class="k">'+esc(e.kind)+'</span>'+
      '<span class="who">'+esc(e.actor)+'</span><span class="sub">'+esc(e.subject)+esc(extra)+'</span>';
    feed.insertBefore(row, feed.firstChild);
    while (feed.childNodes.length > FEED_MAX) feed.removeChild(feed.lastChild);
    $("nev").textContent = ++nev;
  }

  // ---- stream -----------------------------------------------------------------------------------
  function setConn(cls, text) { $("dot").className = "dot " + cls; $("conn").textContent = text; }
  var rafPending = false;
  function scheduleTasks() { if (rafPending) return; rafPending = true;
    requestAnimationFrame(function () { rafPending = false; renderTasks(); }); }

  function onEvent(e) {
    if (e.kind === "twin.graph" && e.payload) foldTwin(e.subject, e.payload);
    else fold(e), scheduleTasks();
    pushFeed(e);
  }
  function connect() {
    setConn("wait", "connecting…");
    var es = new EventSource(url);
    es.onopen = function () { setConn("on", "live"); };
    es.onerror = function () { setConn("off", "reconnecting…"); };
    es.onmessage = function (m) { var e; try { e = JSON.parse(m.data); } catch (_) { return; } onEvent(e); };
  }
  connect();
})();
</script>
</body>
</html>`;
