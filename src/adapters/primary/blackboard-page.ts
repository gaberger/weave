/**
 * The blackboard page (ADR-0025) — a self-contained single-file HTML/JS surface served at `GET /` by
 * the SSE adapter. It connects to `/events` via EventSource and renders two live panels: a task grid
 * (state folded from the event stream, per subject) and a raw event feed. No build step, no deps — a
 * hand-rolled canvas in the spirit of forward-report-graph's self-contained SVG-in-HTML.
 *
 * Kept as a TS string (not a .html file) so `bun build --compile` bundles it into the binary rather
 * than needing a sibling asset at runtime.
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
  main { flex:1; display:grid; grid-template-columns:1.4fr 1fr; gap:1px; background:var(--line); min-height:0; }
  section { background:var(--panel); display:flex; flex-direction:column; min-height:0; }
  .head { padding:8px 14px; color:var(--dim); text-transform:uppercase; letter-spacing:.12em; font-size:11px;
          border-bottom:1px solid var(--line); }
  .body { flex:1; overflow:auto; padding:10px; }
  /* task grid */
  #tasks { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:10px; align-content:start; }
  .card { border:1px solid var(--line); border-left:3px solid var(--dim); border-radius:7px;
          padding:9px 11px; background:#0b141d; transition:border-color .3s, box-shadow .3s; }
  .card.declared { border-left-color:var(--dim); }
  .card.claimed  { border-left-color:var(--violet); box-shadow:var(--glow) rgba(169,139,255,.15); }
  .card.running  { border-left-color:var(--cyan);   box-shadow:var(--glow) rgba(63,208,230,.18); }
  .card.completed{ border-left-color:var(--green); }
  .card.failed   { border-left-color:var(--red);   box-shadow:var(--glow) rgba(255,92,114,.18); }
  .card.cancelled{ border-left-color:var(--amber); opacity:.7; }
  .card .id { color:var(--cyan); font-weight:600; }
  .card .badge { float:right; font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--dim); }
  .card.running  .badge { color:var(--cyan); }
  .card.completed .badge { color:var(--green); }
  .card.failed   .badge { color:var(--red); }
  .card.claimed  .badge { color:var(--violet); }
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
  .ev .who { color:var(--dim); min-width:96px; overflow:hidden; text-overflow:ellipsis; }
  .ev .sub { color:var(--ink); overflow:hidden; text-overflow:ellipsis; }
  .ev.declared .k{color:var(--dim)} .ev.claimed .k{color:var(--violet)} .ev.progress .k{color:var(--cyan)}
  .ev.completed .k{color:var(--green)} .ev.failed .k{color:var(--red)} .ev.tool .k{color:var(--amber)}
  .ev.learning .k{color:var(--violet)} .ev.cancel .k{color:var(--amber)} .ev.released .k{color:var(--dim)}
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
  <section>
    <div class="head">tasks</div>
    <div class="body"><div id="tasks"></div><div id="tempty" class="empty">waiting for the first task…</div></div>
  </section>
  <section>
    <div class="head">event stream</div>
    <div class="body"><div id="feed"></div></div>
  </section>
</main>
<script>
(function () {
  var FEED_MAX = 300;
  var tasks = new Map();        // subject -> {state, goal, skill, owner, note, seq, ts, err}
  var nev = 0;
  var qs = new URLSearchParams(location.search);
  var url = "/events" + (qs.get("secret") ? "?secret=" + encodeURIComponent(qs.get("secret")) : "");

  var $ = function (id) { return document.getElementById(id); };
  // Escape for both element-content and attribute contexts (incl. quotes) — event fields like a
  // task goal are untrusted (they can carry any text a declarer wrote), so everything interpolated
  // into markup goes through here. The only values placed in attributes are internal enums.
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]; }); };

  // Fold one event into the per-subject task state. Returns the feed-row css class for the event kind.
  function kindClass(kind) {
    if (kind === "task.declared") return "declared";
    if (kind === "task.claimed") return "claimed";
    if (kind === "task.progress") return "progress";
    if (kind === "task.completed") return "completed";
    if (kind === "task.failed") return "failed";
    if (kind === "task.released") return "released";
    if (kind === "task.cancel") return "cancel";
    if (kind === "tool.invoked") return "tool";
    if (kind && kind.indexOf("learning.") === 0) return "learning";
    return "";
  }

  function fold(e) {
    // Only task-lifecycle events carry a task subject we grid; learning/tool still stream in the feed.
    var isTask = e.kind && e.kind.indexOf("task.") === 0;
    if (!isTask) return;
    var t = tasks.get(e.subject) || { goal:"", skill:"", owner:"", note:"", err:"", state:"declared" };
    var p = e.payload || {};
    switch (e.kind) {
      case "task.declared": t.state = "declared"; t.goal = p.goal || t.goal; t.skill = p.skill || t.skill; break;
      case "task.claimed":  t.state = "claimed";  t.owner = e.actor; break;
      case "task.progress": t.state = "running";  if (p.note) t.note = p.note; break;
      case "task.completed":t.state = "completed"; break;
      case "task.failed":   t.state = "failed";   t.err = (p.error || "").split("\n")[0]; break;
      case "task.released": if (t.state !== "completed" && t.state !== "failed") t.state = "declared"; break;
      case "task.cancel":   t.state = "cancelled"; break;
    }
    t.seq = e.seq; t.ts = e.ts;
    tasks.set(e.subject, t);
  }

  function renderTasks() {
    var el = $("tasks");
    var entries = Array.from(tasks.entries());
    $("tempty").style.display = entries.length ? "none" : "block";
    // active first (running/claimed), then by recency
    var rank = { running:0, claimed:1, declared:2, failed:3, completed:4, cancelled:5 };
    entries.sort(function (a, b) {
      var d = (rank[a[1].state] - rank[b[1].state]); return d !== 0 ? d : b[1].seq - a[1].seq; });
    el.innerHTML = entries.map(function (kv) {
      var id = kv[0], t = kv[1];
      return '<div class="card ' + t.state + '">' +
        '<span class="badge">' + t.state + '</span>' +
        '<span class="id">' + esc(id) + '</span>' +
        '<div class="goal">' + (esc(t.goal) || '<span style="color:var(--dim)">—</span>') + '</div>' +
        '<div class="meta">' + (t.skill ? esc(t.skill) + ' · ' : '') + (t.owner ? '@' + esc(t.owner) : 'unclaimed') + '</div>' +
        (t.state === "failed" && t.err ? '<div class="note" style="color:var(--red)">' + esc(t.err) + '</div>'
          : (t.note ? '<div class="note">' + esc(t.note) + '</div>' : '')) +
      '</div>';
    }).join("");
    $("ntasks").textContent = entries.length;
  }

  function pushFeed(e) {
    var feed = $("feed");
    var row = document.createElement("div");
    row.className = "ev " + kindClass(e.kind);
    var extra = "";
    if (e.kind === "task.progress" && e.payload && e.payload.note) extra = " — " + e.payload.note;
    else if (e.kind === "task.failed" && e.payload && e.payload.error) extra = " — " + String(e.payload.error).split("\n")[0];
    row.innerHTML = '<span class="seq">#' + e.seq + '</span>' +
      '<span class="k">' + esc(e.kind) + '</span>' +
      '<span class="who">' + esc(e.actor) + '</span>' +
      '<span class="sub">' + esc(e.subject) + esc(extra) + '</span>';
    feed.insertBefore(row, feed.firstChild);
    while (feed.childNodes.length > FEED_MAX) feed.removeChild(feed.lastChild);
    $("nev").textContent = ++nev;
  }

  function setConn(cls, text) { $("dot").className = "dot " + cls; $("conn").textContent = text; }

  var es;
  var rafPending = false;
  function scheduleRender() {
    if (rafPending) return; rafPending = true;
    requestAnimationFrame(function () { rafPending = false; renderTasks(); });
  }

  function connect() {
    setConn("wait", "connecting…");
    es = new EventSource(url);
    es.onopen = function () { setConn("on", "live"); };
    es.onerror = function () { setConn("off", "reconnecting…"); }; // EventSource auto-retries
    es.onmessage = function (m) {
      var e; try { e = JSON.parse(m.data); } catch (_) { return; }
      fold(e); pushFeed(e); scheduleRender();
    };
  }
  connect();
})();
</script>
</body>
</html>`;
