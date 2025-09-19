// app.js
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_VIOLATIONS = 100;

/* ------------ helpers ------------- */

// Get commit -> tree -> blob, then return exact text for a given path
async function getBlobText(octokit, { owner, repo, commitSha, path }) {
  // 1) commit -> tree sha
  const commit = await octokit.repos.getCommit({ owner, repo, ref: commitSha });
  const treeSha = commit.data.commit.tree.sha;

  // 2) walk tree to find the blob sha for this path
  const { data } = await octokit.git.getTree({
    owner, repo, tree_sha: treeSha, recursive: "1",
  });

  const match = (data.tree || []).find(
    (n) => n.type === "blob" && n.path === path
  );
  if (!match) return null;

  // 3) fetch blob bytes (base64)
  const blob = await octokit.git.getBlob({ owner, repo, file_sha: match.sha });
  const b64 = blob.data.content; // base64
  return Buffer.from(b64, "base64").toString("utf8");
}

// Safer JSON parse with last-resort trim if transport injected garbage
function parseJSONSafe(raw, ctx, label = "json") {
  try {
    return JSON.parse(raw);
  } catch (e) {
    // try trimming to last closing brace
    const i = raw.lastIndexOf("}");
    if (i > 0) {
      const trimmed = raw.slice(0, i + 1);
      try {
        return JSON.parse(trimmed);
      } catch {}
    }
    ctx?.log?.warn(`day0: failed parsing ${label}: ${e.message}`);
    return null;
  }
}

async function findLockfiles(octokit, { owner, repo, commitSha }) {
  const commit = await octokit.repos.getCommit({ owner, repo, ref: commitSha });
  const treeSha = commit.data.commit.tree.sha;
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
  walk(lock?.dependencies || {});
}

function collectFromNpmLockV2Plus(lock, deps) {
  const packages = lock?.packages || {};
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

    const check = await ctx.octokit.checks.create({
      owner: login, repo,
      name: "Day-0 Dependency Guard",
      head_sha: sha, status: "in_progress",
    });

    const deps = new Set();

    try {
      // Try common root files first (fast path for your Vite app)
      for (const rootPath of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
        const raw = await getBlobText(ctx.octokit, { owner: login, repo, commitSha: sha, path: rootPath });
        if (!raw) continue;

        if (rootPath === "package-lock.json") {
          const lock = parseJSONSafe(raw, ctx, rootPath);
          if (lock) {
            if (lock.lockfileVersion && lock.lockfileVersion >= 2) {
              collectFromNpmLockV2Plus(lock, deps);
            } else {
              collectFromNpmLockV1(lock, deps);
            }
            ctx.log.info(`day0: parsed ${rootPath}, deps=${deps.size}`);
          }
        } else if (rootPath === "pnpm-lock.yaml") {
          collectFromPnpmLock(raw, deps);
          ctx.log.info(`day0: parsed pnpm-lock.yaml, deps=${deps.size}`);
        } else if (rootPath === "yarn.lock") {
          collectFromYarnLock(raw, deps);
          ctx.log.info(`day0: parsed yarn.lock, deps=${deps.size}`);
        }
      }

      // If still nothing, scan the whole tree (monorepo support)
      if (!deps.size) {
        const lockfiles = await findLockfiles(ctx.octokit, { owner: login, repo, commitSha: sha });
        ctx.log.info(`day0: found lockfiles ${JSON.stringify(lockfiles)}`);

        for (const lf of lockfiles) {
          const raw = await getBlobText(ctx.octokit, { owner: login, repo, commitSha: sha, path: lf });
          if (!raw) {
            ctx.log.warn(`day0: could not read ${lf}`);
            continue;
          }

          if (lf.endsWith("package-lock.json")) {
            const lock = parseJSONSafe(raw, ctx, lf);
            if (lock) {
              if (lock.lockfileVersion && lock.lockfileVersion >= 2) {
                collectFromNpmLockV2Plus(lock, deps);
              } else {
                collectFromNpmLockV1(lock, deps);
              }
              ctx.log.info(`day0: parsed ${lf}, deps=${deps.size}`);
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
