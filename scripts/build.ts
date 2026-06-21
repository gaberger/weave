#!/usr/bin/env bun
// Multi-platform builder: compiles src/cli.ts into standalone binaries
// for each target in TARGETS, written to dist/weave-<platform>-<arch>.
//
// Usage:
//   bun run scripts/build.ts                 # build all targets
//   bun run scripts/build.ts --target darwin-arm64,linux-x64
//   bun run scripts/build.ts --parallel      # run builds concurrently

import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(ROOT, "src/cli.ts");
const OUT_DIR = join(ROOT, "dist");

interface Target {
  readonly platform: "darwin" | "linux";
  readonly arch: "arm64" | "x64";
}

const TARGETS: readonly Target[] = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "arm64" },
  { platform: "linux", arch: "x64" },
];

interface BuildResult {
  readonly target: Target;
  readonly ok: boolean;
  readonly outfile: string;
  readonly bytes: number;
  readonly ms: number;
  readonly error?: string;
}

function targetName(t: Target): string {
  return `${t.platform}-${t.arch}`;
}

function outfileFor(t: Target): string {
  return join(OUT_DIR, `weave-${targetName(t)}`);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function parseArgs(argv: readonly string[]): { targets: readonly Target[]; parallel: boolean } {
  let filter: Set<string> | null = null;
  let parallel = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--parallel") parallel = true;
    else if (a === "--target") filter = new Set((argv[++i] ?? "").split(",").filter(Boolean));
    else if (a.startsWith("--target=")) filter = new Set(a.slice("--target=".length).split(",").filter(Boolean));
  }
  const targets = filter ? TARGETS.filter((t) => filter!.has(targetName(t))) : TARGETS;
  if (targets.length === 0) {
    console.error(`no targets matched; available: ${TARGETS.map(targetName).join(", ")}`);
    process.exit(2);
  }
  return { targets, parallel };
}

async function buildTarget(target: Target): Promise<BuildResult> {
  const outfile = outfileFor(target);
  const cmd = ["bun", "build", ENTRY, "--compile", `--target=bun-${target.platform}-${target.arch}`, `--outfile=${outfile}`];
  const start = Date.now();
  const proc = Bun.spawn({ cmd, cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [exit, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  const ms = Date.now() - start;
  if (exit !== 0) return { target, ok: false, outfile, bytes: 0, ms, error: stderr.trim().split("\n").pop() ?? `exit ${exit}` };
  const bytes = (await stat(outfile).catch(() => null))?.size ?? 0;
  if (bytes === 0) return { target, ok: false, outfile, bytes: 0, ms, error: "outfile missing or empty" };
  return { target, ok: true, outfile, bytes, ms };
}

async function main(): Promise<void> {
  const { targets, parallel } = parseArgs(process.argv.slice(2));
  await mkdir(OUT_DIR, { recursive: true });

  console.log(`▶ building ${targets.length} target(s) ${parallel ? "in parallel" : "sequentially"}`);
  const results = parallel
    ? await Promise.all(targets.map(buildTarget))
    : await (async () => {
        const out: BuildResult[] = [];
        for (const t of targets) out.push(await buildTarget(t));
        return out;
      })();

  console.log("\n── results ───────────────────────────────");
  for (const r of results) {
    const status = r.ok ? "✓" : "✗";
    const detail = r.ok ? `${formatSize(r.bytes)} in ${r.ms}ms` : (r.error ?? "failed");
    console.log(`  ${status} ${targetName(r.target).padEnd(14)} ${detail}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  if (failed > 0) {
    console.error(`\n${failed}/${results.length} target(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
