// app.js
const WINDOW_MS = 24 * 60 * 60 * 1000;

export default (app) => {
  app.on(["pull_request.opened","pull_request.synchronize"], async (ctx) => {
    const { owner, name: repo } = ctx.payload.repository;
    const sha = ctx.payload.pull_request.head.sha;

    // Start check
    const check = await ctx.octokit.checks.create({
      owner: owner.login, repo,
      name: "Day-0 Dependency Guard",
      head_sha: sha, status: "in_progress"
    });

    // Get dependency list via GitHub API (lockfile)
    // Simpler: ask repo to run “npm ls” would require Actions. Here we fetch package-lock/yarn.lock/pnpm-lock
    // For a first cut, read package.json dependencies only:
    const path = "package-lock.json";
    let deps = new Set();

    try {
      const res = await ctx.octokit.repos.getContent({ owner: owner.login, repo, path, ref: sha });
      const content = Buffer.from(res.data.content, "base64").toString("utf8");
      const lock = JSON.parse(content);

      function walk(node) {
        if (!node?.packages) return;
        for (const [p, info] of Object.entries(node.packages)) {
          if (info?.version && p) deps.add(`${p === "" ? lock.name : p.replace(/^node_modules\//,"")}@${info.version}`);
        }
      }
      walk(lock);
    } catch {
      // fallback: skip if no lock found
    }

    // Query npm publish times
    const now = Date.now();
    const violations = [];
    for (const spec of deps) {
      const at = spec.lastIndexOf("@");
      if (at <= 0) continue;
      const name = spec.slice(0, at);
      const version = spec.slice(at + 1);
      const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
      try {
        const r = await fetch(url, { headers: { Accept: "application/vnd.npm.install-v1+json" } });
        if (!r.ok) continue;
        const meta = await r.json();
        const ts = meta?.time?.[version];
        if (!ts) continue;
        if (now - new Date(ts).getTime() < WINDOW_MS) violations.push({ name, version, ts });
      } catch {}
      if (violations.length > 100) break;
    }

    const badge = violations.length ? "❌ Day-0 packages found" : "✅ No Day-0 packages";
    const table = violations.map(v => `| \`${v.name}\` | \`${v.version}\` | ${v.ts} |`).join("\n") || "| — | — | — |";

    // Comment
    await ctx.octokit.issues.createComment({
      owner: owner.login, repo,
      issue_number: ctx.payload.pull_request.number,
      body: `**${badge}**\n\n**Window:** last 24 hours\n**Checked:** ${deps.size} resolved entries\n\n| Package | Version | Published |\n|---|---|---|\n${table}\n\nThis PR is blocked until dependencies fall outside the Day-0 window.`
    });

    // Complete check (fail to block merge)
    await ctx.octokit.checks.update({
      owner: owner.login, repo, check_run_id: check.data.id,
      status: "completed",
      conclusion: violations.length ? "failure" : "success",
      output: { title: "Day-0 Dependency Guard", summary: badge }
    });
  });
};
