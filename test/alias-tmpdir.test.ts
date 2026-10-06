import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { rootEvents, writeBundle } from "./helpers.js";

const execFileAsync = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function fakeOpenClaw(root: string) {
  const bundles = join(root, "bundles");
  await writeBundle({
    root: bundles,
    name: "root",
    sessionId: "root-session",
    sessionKey: "agent:main:main",
    events: rootEvents(),
  });
  const listing = {
    sessions: [
      {
        key: "agent:main:main",
        sessionId: "root-session",
        updatedAt: 1,
      },
    ],
    hasMore: false,
  };
  const script = join(root, "openclaw.mjs");
  await writeFile(
    script,
    `#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2026.8.1-test"); process.exit(0); }
if (args[0] === "config") { console.log(JSON.stringify({ valid: true, path: process.env.OPENCLAW_CONFIG_PATH })); process.exit(0); }
if (args[0] === "doctor" && args.includes("--help")) { console.log("--session-sqlite --session-sqlite-all-agents"); process.exit(0); }
if (args[0] === "doctor") {
  const state = process.env.OPENCLAW_STATE_DIR;
  console.log(JSON.stringify({ mode: args[2], targets: [{ agentId: "main", storePath: join(state, "sessions.json"), sqlitePath: join(state, "openclaw-agent.sqlite"), issues: [] }], totals: { targets: 1, issues: 0 } }));
  process.exit(0);
}
if (args[0] === "sessions" && args[1] === "export-trajectory" && args.includes("--help")) { console.log("openclaw sessions export-trajectory"); process.exit(0); }
if (args[0] === "sessions" && args.includes("--all-agents")) { console.log(${JSON.stringify(JSON.stringify(listing))}); process.exit(0); }
if (args[0] === "sessions" && args[1] === "export-trajectory") {
  if (process.env.FAIL_EXPORT === "1") process.exit(3);
  const workspace = args[args.indexOf("--workspace") + 1];
  const output = args[args.indexOf("--output") + 1];
  const destination = join(workspace, ".openclaw", "trajectory-exports", output);
  await mkdir(join(workspace, ".openclaw", "trajectory-exports"), { recursive: true });
  await cp(join(${JSON.stringify(bundles)}, "root"), destination, { recursive: true });
  const manifestPath = join(destination, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.generatedAt = new Date().toISOString();
  await writeFile(manifestPath, JSON.stringify(manifest));
  console.log(JSON.stringify({ outputDir: destination, sessionId: "root-session", files: ["manifest.json", "events.jsonl", "session-branch.json"] }));
  process.exit(0);
}
process.exit(2);
`,
  );
  await chmod(script, 0o700);
  return script;
}

async function runExport(params: {
  alias: string;
  executable: string;
  output: string;
  fail: boolean;
}) {
  const runner = join(`${params.output}-runner.mjs`);
  await mkdir(dirname(runner), { recursive: true });
  await writeFile(
    runner,
    `import { exportOpenClawFamily } from ${JSON.stringify(join(packageRoot, "dist/index.js"))};
const result = await exportOpenClawFamily({
  executable: ${JSON.stringify(params.executable)},
  sessionKey: "agent:main:main",
  output: ${JSON.stringify(params.output)},
  keepSourceBundles: true,
  retries: 1,
});
console.log(JSON.stringify({ sourceBundleRoot: result.sourceBundleRoot ?? null }));
`,
  );
  return execFileAsync(process.execPath, [runner], {
    cwd: packageRoot,
    env: {
      ...process.env,
      TMPDIR: params.alias,
      FAIL_EXPORT: params.fail ? "1" : "0",
    },
  });
}

describe("temporary directory alias", () => {
  it("keeps a retained export and removes a failed one when TMPDIR is an alias", async () => {
    expect(process.version.startsWith("v24.")).toBe(true);
    const parent = await mkdtemp(join(tmpdir(), "atif-alias-"));
    const real = join(parent, "real");
    const alias = join(parent, "alias");
    await mkdir(real);
    await symlink(real, alias);
    const executable = await fakeOpenClaw(parent);
    const output = join(parent, "out");
    const succeeded = await runExport({ alias, executable, output, fail: false });
    const parsed = JSON.parse(succeeded.stdout) as { sourceBundleRoot: string | null };
    const retained = parsed.sourceBundleRoot;
    if (!retained) throw new Error("missing retained source bundles");
    const canonical = await realpath(real);
    expect(retained.startsWith(canonical + sep)).toBe(true);
    expect(retained.includes(`${sep}alias${sep}`)).toBe(false);
    const graph = JSON.parse(await readFile(join(retained, "graph.json"), "utf8")) as {
      nodes: { bundleDir: string }[];
    };
    expect(graph.nodes.length).toBeGreaterThan(0);
    for (const node of graph.nodes) {
      expect(isAbsolute(node.bundleDir)).toBe(false);
      expect(node.bundleDir.split(sep).includes("..")).toBe(false);
    }
    const kept = basename(retained);
    await expect(
      runExport({ alias, executable, output: join(parent, "failed"), fail: true }),
    ).rejects.toThrow();
    const leftovers = (await readdir(real)).filter(
      (name) => name.startsWith(".openclaw-atif-") && name !== kept,
    );
    expect(leftovers).toEqual([]);
    await rm(parent, { recursive: true, force: true });
  });
});
