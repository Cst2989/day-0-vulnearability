// app.js
const WINDOW_MS = 24 * 60 * 60 * 1000;

async function readTextFileFromRepo(octokit, { owner, repo, ref, path }) {
  try {
    const res = await octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(res.data)) return null; // it's a directory
    return Buffer.from(res.data.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export default (app) => {
  app.on(["pull_request.opened","pull_request.synchronize"], async (ctx) => {
    const { owner, name: repo } = ctx.payload.repository;
    const login = owner.login;
    const sha = ctx.payload.pull_request.head.sha;

    // Start check
    const check = await ctx.octokit.checks.create({
      owner: login, repo,
      name: "Day-0 Dependency Guard",
      head_sha: sha, status: "in_progress"
    });

    // Collect deps from lockfiles (prefer npm lock v2+; fallback to pnpm/yarn)
    const deps = new Set();

    // 1) npm lockfile
    const pkgLockRaw = await readTextFileFromRepo(ctx.octokit, {
      owner: login, repo, ref: sha, path: "package-lock.json"
    });
    if (pkgLockRaw) {
      try {
        const lock = JSON.parse(pkgLockRaw);
        const packages = lock.packages || {}; // npm v7+ structure
        for (const [p, info] of Object.entries(packages)) {
          if (!info?.version) continue;
          // p === "" is root; otherwise "node_modules/<name>"
          const name = p === "" ? lock.name : p.replace(/^node_modules\//, "");
          if (name) deps.add(`${name}@${info.version}`);
        }
        ctx.log.info(`day0: collected ${deps.size} from package-lock.json`);
      } catch (e) {
        ctx.log.warn(`day0: failed to parse package-lock.json: ${e.message}`);
      }
    }

    // 2) pnpm lock (very light, just the top-level spec versions)
    if (!deps.size) {
      const pnpmLock = await readTextFileFromRepo(ctx.octokit, {
        owner: login, repo, ref: sha, path: "pnpm-lock.yaml"
      });
      if (pnpmLock) {
        // quick-and-dirty parse: lines like "  <name>@<specifier>:\n    version: <x>"
        const lines = pnpmLock.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(/^\s{2}([^:@\s].*?):\s*$/); // key line
          if (m && lines[i+1]?.includes("version:")) {
            const vMatch = lines[i+1].match(/version:\s+(.+)\s*$/);
            if (vMatch) deps.add(`${m[1]}@${vMatch[1]}`);
          }
        }
        ctx.log.info(`day0: collected ~${deps.size} from pnpm-lock.yaml`);
      }
    }

    // 3) yarn lock (classic) – best-effort extract of "name@version" lines
    if (!deps.size) {
      const yarnLock = await readTextFileFromRepo(ctx.octokit, {
        owner: login, repo, ref: sha, path: "yarn.lock"
      });
      if (yarnLock) {
        const entries = yarnLock.split("\n\n");
        for (const block of entries) {
          const version = block.match(/version\s+"([^"]+)"/)?.[1];
          const keyLine = block.split("\n")[0] || "";
          // key line like: "package-name@^1.2.3:"
          const name = keyLine.split("@")[0].replace(/"/g,"").trim();
          if (name && version) deps.add(`${name}@${version}`);
        }
        ctx.log.info(`day0: collected ~${deps.size} from yarn.lock`);
      }
    }

    // If still nothing, bail gracefully
    if (!deps.size) {
      await ctx.octokit.issues.createComment({
        owner: login, repo,
        issue_number: ctx.payload.pull_request.number,
        body: `ℹ️ Day-0 Guard: no lockfile detected. Add a lockfile (npm/pnpm/yarn) to enable checks.`
      });
      await ctx.octokit.checks.update({
        owner: login, repo, check_run_id: check.data.id,
        status: "completed",
        conclusion: "neutral",
        output: { title: "Day-0 Dependency Guard", summary: "No lockfile detected" }
      });
      return;
    }

    // Query npm publish times
    const now = Date.now();
    const violations = [];
    for (const spec of deps) {
      // Safe split for scoped packages: take last "@"
      const at = spec.lastIndexOf("@");
      if (at <= 0) continue;
      const name = spec.slice(0, at);
      const version = spec.slice(at + 1);

      try {
        const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
        const r = await fetch(url, { headers: { Accept: "application/vnd.npm.install-v1+json" } });
        if (!r.ok) continue;
        const meta = await r.json();
        const ts = meta?.time?.[version];
        if (!ts) continue;
        if (now - new Date(ts).getTime() < WINDOW_MS) {
          violations.push({ name, version, ts });
          if (violations.length >= 100) break;
        }
      } catch (e) {
        ctx.log.warn(`day0: registry lookup failed for ${spec}: ${e.message}`);
      }
    }

    const badge = violations.length ? "❌ Day-0 packages found" : "✅ No Day-0 packages";
    const table = violations.map(v => `| \`${v.name}\` | \`${v.version}\` | ${v.ts} |`).join("\n") || "| — | — | — |";

    // Comment
    await ctx.octokit.issues.createComment({
      owner: login, repo,
      issue_number: ctx.payload.pull_request.number,
      body: `**${badge}**\n\n**Window:** last 24 hours\n**Checked:** ${deps.size} resolved entries\n\n| Package | Version | Published |\n|---|---|---|\n${table}\n\nThis PR is blocked until dependencies fall outside the Day-0 window.`
    });

    // Complete check (fail to block merge)
    await ctx.octokit.checks.update({
      owner: login, repo, check_run_id: check.data.id,
      status: "completed",
      conclusion: violations.length ? "failure" : "success",
      output: { title: "Day-0 Dependency Guard", summary: badge }
    });
  });
};
