// app.js
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_VIOLATIONS = 100;

/* ------------ helpers ------------- */

async function readTextFileFromRepo(octokit, { owner, repo, ref, path }) {
  try {
    const res = await octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(res.data)) return null; // directory
    if (res.data.encoding === "base64" && res.data.content) {
      return Buffer.from(res.data.content, "base64").toString("utf8");
    }
    if (res.data.download_url) {
      const r = await fetch(res.data.download_url);
      if (r.ok) return await r.text();
    }
    return null;
  } catch {
    return null;
  }
}

async function findLockfiles(octokit, { owner, repo, commitSha }) {
  // 1) Resolve the commit → tree SHA (this was the bug)
  const commit = await octokit.repos.getCommit({ owner, repo, ref: commitSha });
  const treeSha = commit.data.commit.tree.sha;

  // 2) Walk the tree (recursive) to find lockfiles anywhere
  const { data } = await octokit.git.getTree({
    owner, repo, tree_sha: treeSha, recursive: "1",
  });

  const out = [];
  for (const item of data.tree || []) {
    if (item.type !== "blob") continue;
    if (/(?:^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(item.path)) {
      out.push(item.path);
    }
  }
  return out;
}

function collectFromNpmLockV1(lock, deps) {
  function walk(depMap) {
    for (const [name, info] of Object.entries(depMap || {})) {
      if (info?.version) deps.add(`${name}@${info.version}`);
      if (info?.dependencies) walk(info.dependencies);
    }
  }
  walk(lock.dependencies || {});
}

function collectFromNpmLockV2Plus(lock, deps) {
  const packages = lock.packages || {};
  for (const [p, info] of Object.entries(packages)) {
    if (!info?.version) continue;
    const name = p === "" ? lock.name : p.replace(/^node_modules\//, "");
    if (name) deps.add(`${name}@${info.version}`);
  }
}

function collectFromPnpmLock(raw, deps) {
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s{2}([^:@\s][^:]*):\s*$/);
    if (m && lines[i + 1]?.includes("version:")) {
      const v = lines[i + 1].match(/version:\s+(.+)\s*$/)?.[1];
      if (v) deps.add(`${m[1]}@${v}`);
    }
  }
}

function collectFromYarnLock(raw, deps) {
  const blocks = raw.split("\n\n");
  for (const block of blocks) {
    const version = block.match(/version\s+"([^"]+)"/)?.[1];
    if (!version) continue;
    let key = (block.split("\n")[0] || "").replace(/(^"|":?$)/g, "");
    if (key.includes(", ")) key = key.split(", ")[0];
    let name = key;
    if (name.startsWith("@")) {
      const parts = name.split("@").filter(Boolean);
      if (parts.length >= 2) name = `@${parts[0]}/${parts[1]}`;
    } else {
      const at = name.lastIndexOf("@");
      if (at > 0) name = name.slice(0, at);
    }
    name = name.replace(/^"|"$/g, "").trim();
    if (name) deps.add(`${name}@${version}`);
  }
}

/* -------------- app --------------- */

export default (app) => {
  app.on(["pull_request.opened", "pull_request.synchronize"], async (ctx) => {
    const { owner, name: repo } = ctx.payload.repository;
    const login = owner.login;
    const sha = ctx.payload.pull_request.head.sha;

    ctx.log.info("day0:event", { action: ctx.payload.action, sha });

    // Start check
    const check = await ctx.octokit.checks.create({
      owner: login, repo,
      name: "Day-0 Dependency Guard",
      head_sha: sha, status: "in_progress",
    });

    const deps = new Set();

    try {
      // Prefer exact file at repo root first (your case)
      for (const rootPath of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
        const raw = await readTextFileFromRepo(ctx.octokit, { owner: login, repo, ref: sha, path: rootPath });
        if (!raw) continue;

        if (rootPath === "package-lock.json") {
          try {
            const lock = JSON.parse(raw);
            if (lock.lockfileVersion && lock.lockfileVersion >= 2) {
              collectFromNpmLockV2Plus(lock, deps);
            } else {
              collectFromNpmLockV1(lock, deps);
            }
            ctx.log.info(`day0: parsed ${rootPath}, deps=${deps.size}`);
          } catch (e) {
            ctx.log.warn(`day0: failed parsing ${rootPath}: ${e.message}`);
          }
        } else if (rootPath === "pnpm-lock.yaml") {
          collectFromPnpmLock(raw, deps);
          ctx.log.info(`day0: parsed pnpm-lock.yaml, deps=${deps.size}`);
        } else if (rootPath === "yarn.lock") {
          collectFromYarnLock(raw, deps);
          ctx.log.info(`day0: parsed yarn.lock, deps=${deps.size}`);
        }
      }

      // If nothing yet, scan the tree (monorepo support, or non-root file)
      if (!deps.size) {
        const lockfiles = await findLockfiles(ctx.octokit, { owner: login, repo, commitSha: sha });
        ctx.log.info(`day0: found lockfiles ${JSON.stringify(lockfiles)}`);

        for (const lf of lockfiles) {
          const raw = await readTextFileFromRepo(ctx.octokit, { owner: login, repo, ref: sha, path: lf });
          if (!raw) {
            ctx.log.warn(`day0: could not read ${lf}`);
            continue;
          }
          if (lf.endsWith("package-lock.json")) {
            try {
              const lock = JSON.parse(raw);
              if (lock.lockfileVersion && lock.lockfileVersion >= 2) {
                collectFromNpmLockV2Plus(lock, deps);
              } else {
                collectFromNpmLockV1(lock, deps);
              }
              ctx.log.info(`day0: parsed ${lf}, deps=${deps.size}`);
            } catch (e) {
              ctx.log.warn(`day0: failed parsing ${lf}: ${e.message}`);
            }
          } else if (lf.endsWith("pnpm-lock.yaml")) {
            collectFromPnpmLock(raw, deps);
            ctx.log.info(`day0: parsed ${lf}, deps=${deps.size}`);
          } else if (lf.endsWith("yarn.lock")) {
            collectFromYarnLock(raw, deps);
            ctx.log.info(`day0: parsed ${lf}, deps=${deps.size}`);
          }
          if (deps.size > 5000) break; // safety cap
        }
      }
    } catch (e) {
      ctx.log.error(`day0: lockfile discovery error: ${e.message}`);
    }

    if (!deps.size) {
      await ctx.octokit.issues.createComment({
        owner: login, repo,
        issue_number: ctx.payload.pull_request.number,
        body: `ℹ️ Day-0 Guard: lockfile not parsed. Ensure \`package-lock.json\` / \`pnpm-lock.yaml\` / \`yarn.lock\` is committed (monorepos supported).`,
      });
      await ctx.octokit.checks.update({
        owner: login, repo, check_run_id: check.data.id,
        status: "completed", conclusion: "neutral",
        output: { title: "Day-0 Dependency Guard", summary: "No lockfile parsed" },
      });
      return;
    }

    // Query npm publish times
    const now = Date.now();
    const violations = [];
    for (const spec of deps) {
      const at = spec.lastIndexOf("@"); // safe for scoped packages
      if (at <= 0) continue;
      const name = spec.slice(0, at);
      const version = spec.slice(at + 1);

      try {
        const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
        const r = await fetch(url, { headers: { Accept: "application/vnd.npm.install-v1+json" } });
        if (!r.ok) {
          ctx.log.warn(`day0: registry ${r.status} for ${name}`);
          continue;
        }
        const meta = await r.json();
        const ts = meta?.time?.[version];
        if (!ts) continue;

        if (now - new Date(ts).getTime() < WINDOW_MS) {
          violations.push({ name, version, ts });
          if (violations.length >= MAX_VIOLATIONS) break;
        }
      } catch (e) {
        ctx.log.warn(`day0: registry lookup failed for ${spec}: ${e.message}`);
      }
    }

    const badge = violations.length ? "❌ Day-0 packages found" : "✅ No Day-0 packages";
    const table =
      violations.map(v => `| \`${v.name}\` | \`${v.version}\` | ${v.ts} |`).join("\n") ||
      "| — | — | — |";

    await ctx.octokit.issues.createComment({
      owner: login, repo,
      issue_number: ctx.payload.pull_request.number,
      body:
        `**${badge}**\n\n` +
        `**Window:** last 24 hours\n` +
        `**Checked:** ${deps.size} resolved entries\n\n` +
        `| Package | Version | Published |\n|---|---|---|\n` +
        `${table}\n\n` +
        `This PR is blocked until dependencies fall outside the Day-0 window.`,
    });

    await ctx.octokit.checks.update({
      owner: login, repo, check_run_id: check.data.id,
      status: "completed",
      conclusion: violations.length ? "failure" : "success",
      output: {
        title: "Day-0 Dependency Guard",
        summary: badge,
        text: `${violations.length} package(s) published in the last 24h.`,
      },
    });
  });
};
