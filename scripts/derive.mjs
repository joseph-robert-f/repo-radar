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

/** Minimal glob: `*` matches any run of characters. Enough for branch prefixes. */
const globToRe = (g) =>
  new RegExp(
    "^" +
      g
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );

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
  const ignoreRes = (config.branchIgnore || []).map(globToRe);
  const minUnmerged = config.minUnmergedCommits ?? 1;

  // Scratch branches — the ones an agent or a scheduled job leaves behind —
  // otherwise bury real work. A branch that matches an ignore pattern, or that
  // is fewer than minUnmergedCommits ahead, still shows in the repo's branch
  // count; it just doesn't become a task competing for attention.
  const isWorkBranch = (b) =>
    b.unmergedCommits >= minUnmerged && !ignoreRes.some((re) => re.test(b.name));

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
  //
  // Elapsed-time values (how many days old, how many days idle) are NOT stored.
  // They are pure functions of the clock and an ISO timestamp that is already
  // here, so writing them down would make the snapshot differ on every single
  // run even when nothing happened in any repo — which defeats the workflow's
  // "don't commit if nothing changed" check, and freezes every age on the page
  // at whatever it was when the collector last ran. index.html computes them at
  // render time instead, so they're correct at the moment you look.
  //
  // `status` and `stale` DO stay here: they're threshold crossings, not
  // continuous drift, so they change rarely and when they do it's real news.
  const repos = kept.map((r) => {
    const dates = r.commitDates || [];
    const commits7d = dates.filter((d) => daysBetween(now, d) <= 7).length;
    const commits30d = dates.filter((d) => daysBetween(now, d) <= 30).length;

    const openPRs = (r.openPRs || []).map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      isDraft: !!p.isDraft,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
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
      assigned: !!i.assigned,
    }));

    const branches = (r.branches || []).map((b) => ({
      name: b.name,
      lastCommit: b.lastCommit,
      unmergedCommits: b.unmergedCommits ?? 0,
    }));
    const workBranches = branches.filter(isWorkBranch);

    // When did a human last do something here?
    //
    // NOT `pushedAt`: this dashboard commits its own snapshot to its own repo
    // every 6 hours, which bumped repo-radar's pushedAt and left it permanently
    // "hot" and sorted first — the dashboard measuring itself, the same trap
    // decision 6 dodged for commits. It also meant the file changed on every
    // single run, so the workflow's "nothing changed, don't commit" check could
    // never fire.
    //
    // So: the newest of the non-bot default-branch commits and the real work
    // branches, falling back to pushedAt only when a repo has neither.
    const activity = [
      ...dates.map(Date.parse),
      ...workBranches.map((b) => Date.parse(b.lastCommit)),
    ].filter(Number.isFinite);
    const lastActivityAt = activity.length
      ? new Date(Math.max(...activity)).toISOString()
      : r.pushedAt;
    const idleDaysForStatus = Math.max(0, daysBetween(now, lastActivityAt));

    return {
      name: r.name,
      url: r.url,
      description: r.description ?? null,
      language: r.language ?? null,
      isFork: !!r.isFork,
      isArchived: !!r.isArchived,
      defaultBranch: r.defaultBranch ?? null,
      lastActivityAt,
      status: overrides[r.name] || statusFor(idleDaysForStatus, thresholds),
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
      Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
  );

  // ---- tasks: one flat cross-repo list of everything in flight ------------
  // Each task carries `createdAt` (when it opened) and `updatedAt` (when it
  // last moved) and lets the page turn those into ages. Staleness keys on time
  // since it last moved — a long-lived PR that got a commit yesterday is not a
  // problem, and a week-old one nobody has touched is.
  const tasks = [];

  for (const r of repos) {
    for (const p of r.openPRs) {
      tasks.push({
        type: "pr",
        repo: r.name,
        title: `#${p.number} ${p.title}`,
        url: p.url,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        isDraft: p.isDraft,
        stale:
          daysBetween(now, p.updatedAt) >
          (p.isDraft ? staleDays.draftPr : staleDays.pr),
      });
    }

    for (const i of r.openIssues.filter((i) => i.assigned)) {
      tasks.push({
        type: "issue",
        repo: r.name,
        title: `#${i.number} ${i.title}`,
        url: i.url,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        stale: daysBetween(now, i.updatedAt) > staleDays.issue,
      });
    }

    // A branch with an open PR is already represented by that PR — counting it
    // again would double every piece of reviewed work in the task list.
    const branchesWithPRs = new Set(r.openPRs.map((p) => p.headRef));
    for (const b of r.branches.filter(isWorkBranch)) {
      if (branchesWithPRs.has(b.name)) continue;
      tasks.push({
        type: "branch",
        repo: r.name,
        title: `${b.name} · ${b.unmergedCommits} unmerged`,
        url: r.url ? `${r.url}/tree/${b.name}` : null,
        createdAt: b.lastCommit,
        updatedAt: b.lastCommit,
        stale: daysBetween(now, b.lastCommit) > staleDays.branch,
      });
    }
  }

  // Most-idle first. Sorting on the timestamps rather than on elapsed days
  // gives the identical order without baking the clock into the file.
  tasks.sort(
    (a, b) =>
      Date.parse(a.updatedAt) - Date.parse(b.updatedAt) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
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
    if (!Number.isFinite(Date.parse(r.lastActivityAt))) {
      fail(`repo "${r.name}" missing lastActivityAt`);
    }
    if (Object.hasOwn(r, "pushedAt")) {
      fail(`repo "${r.name}" still carries pushedAt — this dashboard's own bot
        push bumps it, so status and ordering must key on lastActivityAt`);
    }
    if (!["hot", "active", "idle", "dormant"].includes(r.status)) {
      fail(`repo "${r.name}" has unknown status "${r.status}"`);
    }
    for (const k of ["commits7d", "openPRs", "openIssues", "branches"]) {
      if (typeof r.counts?.[k] !== "number") fail(`repo "${r.name}" missing counts.${k}`);
    }
  }

  for (const t of snap.tasks) {
    if (!["pr", "issue", "branch"].includes(t.type)) fail(`task has unknown type "${t.type}"`);
    if (!Number.isFinite(Date.parse(t.createdAt))) fail(`task "${t.title}" missing createdAt`);
    if (!Number.isFinite(Date.parse(t.updatedAt))) fail(`task "${t.title}" missing updatedAt`);
    if (typeof t.stale !== "boolean") fail(`task "${t.title}" missing stale`);
  }

  // Elapsed-day values must not be written down — they're clock-derived, so
  // storing one would make every run produce a different file and silently
  // break the workflow's "nothing changed, don't commit" check. See the note
  // in buildSnapshot. The page computes these from the timestamps instead.
  const DRIFTING = ["ageInDays", "idleDays", "daysSinceLastPush"];
  const scan = (obj, where) => {
    for (const k of DRIFTING) {
      if (obj && Object.hasOwn(obj, k)) fail(`${where} carries clock-derived "${k}"`);
    }
  };
  for (const r of snap.repos) {
    scan(r, `repo "${r.name}"`);
    for (const p of r.openPRs) scan(p, `repo "${r.name}" PR #${p.number}`);
    for (const i of r.openIssues) scan(i, `repo "${r.name}" issue #${i.number}`);
  }
  for (const t of snap.tasks) scan(t, `task "${t.title}"`);

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
