/**
 * Pure derivation layer — no network, no fs, no clock of its own.
 *
 * `collect.mjs` fetches raw GitHub data and hands it here; this module turns it
 * into `data/snapshot.json`. Everything the dashboard actually cares about —
 * status, staleness, the cross-repo task list, the heatmap — is computed here.
 *
 * Kept separate from the fetching so `selftest.mjs` can exercise all of it
 * against fixtures without touching the API.
 */

export const DAY = 86400000;

/** Raw repo shape this module expects from the collector:
 *
 *   { name, url, description, language, pushedAt, isFork, isArchived,
 *     defaultBranch, commits[], openPRs[], openIssues[], branches[],
 *     commitDates[] }
 *
 *   commits[]     { sha, message, date, url }        most recent N, bots removed
 *   openPRs[]     { number, title, url, isDraft, createdAt, updatedAt,
 *                   reviewDecision, additions, deletions, headRef }
 *   openIssues[]  { number, title, url, labels[], createdAt, updatedAt, assigned }
 *   branches[]    { name, lastCommit, unmergedCommits }   non-default only
 *   commitDates[] ISO strings, last 365d, bots removed — drives the heatmap
 */

const round1 = (n) => Math.round(n * 10) / 10;
const daysBetween = (nowMs, iso) =>
  iso == null ? null : (nowMs - Date.parse(iso)) / DAY;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

function statusFor(days, thresholds) {
  if (days < thresholds.hot) return "hot";
  if (days < thresholds.active) return "active";
  if (days < thresholds.idle) return "idle";
  return "dormant";
}

/**
 * Build the snapshot.
 *
 * @param {object[]} rawRepos  normalized repos from the collector
 * @param {object}   config    parsed config.json
 * @param {object}   opts      { user, now: epoch ms }
 */
export function buildSnapshot(rawRepos, config, { user, now }) {
  const thresholds = config.statusThresholdDays;
  const staleDays = config.staleDays;
  const hide = new Set(config.hide || []);
  const pin = config.pin || [];
  const overrides = config.statusOverrides || {};
  const heatmapDays = Math.round((config.lookback?.heatmapWeeks ?? 52) * 7) + 1;

  // ---- filter ------------------------------------------------------------
  // Private repos are excluded at the API query, then again here: a snapshot
  // that reaches a public Pages site must not contain private anything.
  const kept = rawRepos.filter((r) => {
    if (r.isPrivate) return false;
    if (hide.has(r.name)) return false;
    if (r.isFork && config.includeForks === false) return false;
    if (r.isArchived && config.includeArchived === false) return false;
    return true;
  });

  // ---- per-repo ----------------------------------------------------------
  const repos = kept.map((r) => {
    const dates = r.commitDates || [];
    const commits7d = dates.filter((d) => daysBetween(now, d) <= 7).length;
    const commits30d = dates.filter((d) => daysBetween(now, d) <= 30).length;
    const daysSinceLastPush = round1(Math.max(0, daysBetween(now, r.pushedAt)));

    const openPRs = (r.openPRs || []).map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      isDraft: !!p.isDraft,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      ageInDays: round1(daysBetween(now, p.createdAt)),
      idleDays: round1(daysBetween(now, p.updatedAt)),
      reviewDecision: p.reviewDecision ?? null,
      additions: p.additions ?? 0,
      deletions: p.deletions ?? 0,
      headRef: p.headRef,
    }));

    const openIssues = (r.openIssues || []).map((i) => ({
      number: i.number,
      title: i.title,
      url: i.url,
      labels: i.labels || [],
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      ageInDays: round1(daysBetween(now, i.createdAt)),
      idleDays: round1(daysBetween(now, i.updatedAt)),
      assigned: !!i.assigned,
    }));

    const branches = (r.branches || []).map((b) => ({
      name: b.name,
      lastCommit: b.lastCommit,
      unmergedCommits: b.unmergedCommits ?? 0,
    }));

    return {
      name: r.name,
      url: r.url,
      description: r.description ?? null,
      language: r.language ?? null,
      isFork: !!r.isFork,
      isArchived: !!r.isArchived,
      defaultBranch: r.defaultBranch ?? null,
      pushedAt: r.pushedAt,
      daysSinceLastPush,
      status: overrides[r.name] || statusFor(daysSinceLastPush, thresholds),
      pinned: pin.includes(r.name),
      commits: r.commits || [],
      openPRs,
      openIssues,
      branches,
      counts: {
        commits7d,
        commits30d,
        openPRs: openPRs.length,
        openIssues: openIssues.length,
        branches: branches.length,
      },
    };
  });

  // ---- ordering: pinned first (in config order), then most recently pushed
  const pinRank = (name) => {
    const i = pin.indexOf(name);
    return i === -1 ? Infinity : i;
  };
  repos.sort(
    (a, b) =>
      pinRank(a.name) - pinRank(b.name) ||
      Date.parse(b.pushedAt) - Date.parse(a.pushedAt),
  );

  // ---- tasks: one flat cross-repo list of everything in flight ------------
  // `ageInDays` is how long the thing has been open; `idleDays` is how long it
  // has sat untouched. Staleness keys on idleDays — a long-lived PR that moved
  // yesterday is not stale, and a week-old one nobody has touched is.
  const tasks = [];

  for (const r of repos) {
    for (const p of r.openPRs) {
      tasks.push({
        type: "pr",
        repo: r.name,
        title: `#${p.number} ${p.title}`,
        url: p.url,
        ageInDays: p.ageInDays,
        idleDays: p.idleDays,
        isDraft: p.isDraft,
        stale: p.idleDays > (p.isDraft ? staleDays.draftPr : staleDays.pr),
      });
    }

    for (const i of r.openIssues.filter((i) => i.assigned)) {
      tasks.push({
        type: "issue",
        repo: r.name,
        title: `#${i.number} ${i.title}`,
        url: i.url,
        ageInDays: i.ageInDays,
        idleDays: i.idleDays,
        stale: i.idleDays > staleDays.issue,
      });
    }

    // A branch with an open PR is already represented by that PR — counting it
    // again would double every piece of reviewed work in the task list.
    const branchesWithPRs = new Set(r.openPRs.map((p) => p.headRef));
    for (const b of r.branches) {
      if (branchesWithPRs.has(b.name)) continue;
      if (b.unmergedCommits <= 0) continue;
      const age = round1(daysBetween(now, b.lastCommit));
      tasks.push({
        type: "branch",
        repo: r.name,
        title: `${b.name} · ${b.unmergedCommits} unmerged`,
        url: r.url ? `${r.url}/tree/${b.name}` : null,
        ageInDays: age,
        idleDays: age,
        stale: age > staleDays.branch,
      });
    }
  }

  tasks.sort((a, b) => b.idleDays - a.idleDays || b.ageInDays - a.ageInDays);
  const attention = tasks.filter((t) => t.stale);

  // ---- heatmap: daily commit counts across every tracked repo ------------
  const buckets = new Map();
  const todayUTC = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  const firstDay = todayUTC - (heatmapDays - 1) * DAY;
  const datesByRepo = new Map(kept.map((r) => [r.name, r.commitDates || []]));
  for (const r of repos) {
    for (const iso of datesByRepo.get(r.name) || []) {
      const ms = Date.parse(iso);
      if (Number.isNaN(ms) || ms < firstDay) continue;
      const key = ymd(ms);
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
  }
  const heatmap = [];
  for (let d = firstDay; d <= todayUTC; d += DAY) {
    const key = ymd(d);
    heatmap.push({ date: key, count: buckets.get(key) || 0 });
  }

  const summary = {
    repos: repos.length,
    activeRepos: repos.filter((r) => r.status === "hot" || r.status === "active")
      .length,
    openPRs: repos.reduce((n, r) => n + r.counts.openPRs, 0),
    openIssues: repos.reduce((n, r) => n + r.counts.openIssues, 0),
    commits7d: repos.reduce((n, r) => n + r.counts.commits7d, 0),
    needsAttention: attention.length,
  };

  return {
    generatedAt: new Date(now).toISOString(),
    user,
    scope: "public",
    summary,
    repos,
    tasks,
    attention,
    heatmap,
  };
}

/**
 * Cheap structural guard, run on every collect before the file is written.
 * Throws rather than committing a snapshot the page can't render — or, worse,
 * one carrying something that shouldn't be on a public site.
 */
export function assertSnapshot(snap) {
  const fail = (msg) => {
    throw new Error(`snapshot invariant violated: ${msg}`);
  };

  if (snap.scope !== "public") fail(`scope is "${snap.scope}", expected "public"`);
  if (snap.sample) fail("sample flag is set on real output");
  if (!Number.isFinite(Date.parse(snap.generatedAt))) fail("generatedAt unparseable");
  if (!Array.isArray(snap.repos)) fail("repos is not an array");
  if (!Array.isArray(snap.tasks)) fail("tasks is not an array");
  if (!Array.isArray(snap.heatmap)) fail("heatmap is not an array");

  for (const k of ["repos", "activeRepos", "openPRs", "openIssues", "commits7d", "needsAttention"]) {
    if (typeof snap.summary?.[k] !== "number") fail(`summary.${k} missing`);
  }

  for (const r of snap.repos) {
    if (r.isPrivate) fail(`repo "${r.name}" is marked private`);
    if (r.redacted) fail(`repo "${r.name}" carries a redaction flag — that path is gone`);
    if (!r.name || !r.url) fail(`repo "${r.name}" missing name or url`);
    if (!["hot", "active", "idle", "dormant"].includes(r.status)) {
      fail(`repo "${r.name}" has unknown status "${r.status}"`);
    }
    for (const k of ["commits7d", "openPRs", "openIssues", "branches"]) {
      if (typeof r.counts?.[k] !== "number") fail(`repo "${r.name}" missing counts.${k}`);
    }
  }

  for (const t of snap.tasks) {
    if (!["pr", "issue", "branch"].includes(t.type)) fail(`task has unknown type "${t.type}"`);
    if (typeof t.ageInDays !== "number") fail(`task "${t.title}" missing ageInDays`);
    if (typeof t.stale !== "boolean") fail(`task "${t.title}" missing stale`);
  }

  if (snap.attention.length !== snap.tasks.filter((t) => t.stale).length) {
    fail("attention is not the stale subset of tasks");
  }

  const seen = new Set();
  for (const h of snap.heatmap) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date)) fail(`heatmap date "${h.date}" malformed`);
    if (seen.has(h.date)) fail(`heatmap has duplicate date ${h.date}`);
    seen.add(h.date);
    if (typeof h.count !== "number") fail(`heatmap ${h.date} count is not a number`);
  }
}
