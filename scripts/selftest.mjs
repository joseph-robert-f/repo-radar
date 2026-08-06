#!/usr/bin/env node
/**
 * Offline test for the derivation layer.
 *
 *   node scripts/selftest.mjs
 *
 * Every interesting rule in derive.mjs — status thresholds, staleness, the
 * PR/branch de-duplication, hide/pin/statusOverrides, the heatmap window, the
 * private-repo guards — is exercised here against fixtures, with no network.
 * The API shape itself can only be verified by a real run; this covers
 * everything downstream of it.
 */
import { buildSnapshot, assertSnapshot, DAY } from "./derive.mjs";

const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n         ${err.message}`);
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, expected ${e}`);
}
function ok(cond, what) {
  if (!cond) throw new Error(what);
}

const CONFIG = {
  username: "tester",
  hide: ["hidden-repo"],
  pin: ["pinned-repo"],
  statusOverrides: { "forced-repo": "dormant" },
  includeForks: false,
  includeArchived: false,
  lookback: { commitsPerRepo: 10, heatmapWeeks: 52 },
  staleDays: { pr: 7, draftPr: 14, branch: 14, issue: 30 },
  statusThresholdDays: { hot: 3, active: 14, idle: 60 },
};

const repo = (over = {}) => ({
  name: "repo",
  url: "https://github.com/tester/repo",
  description: null,
  language: null,
  isPrivate: false,
  isFork: false,
  isArchived: false,
  pushedAt: ago(1),
  defaultBranch: "main",
  commits: [],
  openPRs: [],
  openIssues: [],
  branches: [],
  commitDates: [],
  ...over,
});

const build = (repos, config = CONFIG) =>
  buildSnapshot(repos, config, { user: "tester", now: NOW });

console.log("derive.mjs");

/* ---------------------------------------------------------------- status */

check("status follows the configured day thresholds", () => {
  const snap = build([
    repo({ name: "a", pushedAt: ago(0.5) }),
    repo({ name: "b", pushedAt: ago(5) }),
    repo({ name: "c", pushedAt: ago(30) }),
    repo({ name: "d", pushedAt: ago(400) }),
  ]);
  const byName = Object.fromEntries(snap.repos.map((r) => [r.name, r.status]));
  eq(byName, { a: "hot", b: "active", c: "idle", d: "dormant" }, "statuses");
});

check("statusOverrides wins over the computed status", () => {
  const snap = build([repo({ name: "forced-repo", pushedAt: ago(0.1) })]);
  eq(snap.repos[0].status, "dormant", "overridden status");
});

/* ---------------------------------------------------------------- filters */

check("hide[] removes a repo entirely", () => {
  const snap = build([repo({ name: "hidden-repo" }), repo({ name: "kept" })]);
  eq(snap.repos.map((r) => r.name), ["kept"], "repo names");
  eq(snap.summary.repos, 1, "summary.repos");
});

check("pin[] sorts to the top ahead of more recent pushes", () => {
  const snap = build([
    repo({ name: "fresh", pushedAt: ago(0.1) }),
    repo({ name: "pinned-repo", pushedAt: ago(300) }),
  ]);
  eq(snap.repos.map((r) => r.name), ["pinned-repo", "fresh"], "order");
  eq(snap.repos[0].pinned, true, "pinned flag");
});

check("unpinned repos sort by most recent push", () => {
  const snap = build([
    repo({ name: "old", pushedAt: ago(40) }),
    repo({ name: "new", pushedAt: ago(2) }),
    repo({ name: "mid", pushedAt: ago(9) }),
  ]);
  eq(snap.repos.map((r) => r.name), ["new", "mid", "old"], "order");
});

check("forks and archived repos are excluded when configured off", () => {
  const snap = build([
    repo({ name: "fork", isFork: true }),
    repo({ name: "archived", isArchived: true }),
    repo({ name: "normal" }),
  ]);
  eq(snap.repos.map((r) => r.name), ["normal"], "repo names");
});

check("forks and archived repos are kept when configured on", () => {
  const snap = build(
    [repo({ name: "fork", isFork: true }), repo({ name: "archived", isArchived: true })],
    { ...CONFIG, includeForks: true, includeArchived: true },
  );
  eq(snap.repos.length, 2, "repo count");
});

/* ------------------------------------------------------ private-repo guard */

check("a private repo is dropped even if one reaches the deriver", () => {
  const snap = build([repo({ name: "secret", isPrivate: true }), repo({ name: "open" })]);
  eq(snap.repos.map((r) => r.name), ["open"], "repo names");
  ok(!JSON.stringify(snap).includes("secret"), "private name absent from the whole snapshot");
});

check("assertSnapshot rejects a snapshot carrying a private repo", () => {
  const snap = build([repo({ name: "open" })]);
  snap.repos[0].isPrivate = true;
  let threw = false;
  try {
    assertSnapshot(snap);
  } catch {
    threw = true;
  }
  ok(threw, "assertSnapshot should have thrown");
});

check("assertSnapshot rejects sample data", () => {
  const snap = build([repo()]);
  snap.sample = true;
  let threw = false;
  try {
    assertSnapshot(snap);
  } catch {
    threw = true;
  }
  ok(threw, "assertSnapshot should have thrown");
});

/* ----------------------------------------------------------------- counts */

check("commits7d and commits30d use the right windows", () => {
  const snap = build([
    repo({ commitDates: [ago(0.2), ago(3), ago(6.9), ago(7.5), ago(29), ago(90)] }),
  ]);
  eq(snap.repos[0].counts.commits7d, 3, "commits7d");
  eq(snap.repos[0].counts.commits30d, 5, "commits30d");
  eq(snap.summary.commits7d, 3, "summary.commits7d");
});

/* ------------------------------------------------------------------ tasks */

check("an open PR becomes a task, stale by idle time not age", () => {
  const snap = build([
    repo({
      name: "r",
      openPRs: [
        // open 90 days, but touched yesterday — not stale
        { number: 1, title: "long-running", url: "u1", isDraft: false, createdAt: ago(90), updatedAt: ago(1), headRef: "a" },
        // open 9 days, untouched for 9 — stale
        { number: 2, title: "forgotten", url: "u2", isDraft: false, createdAt: ago(9), updatedAt: ago(9), headRef: "b" },
      ],
    }),
  ]);
  const byTitle = new Map(snap.tasks.map((t) => [t.title, t.stale]));
  eq(byTitle.get("#1 long-running"), false, "long-running PR is not stale");
  eq(byTitle.get("#2 forgotten"), true, "untouched PR is stale");
  eq(snap.attention.map((t) => t.title), ["#2 forgotten"], "attention list");
});

check("draft PRs get the longer stale threshold", () => {
  const snap = build([
    repo({
      openPRs: [
        { number: 1, title: "draft", url: "u", isDraft: true, createdAt: ago(20), updatedAt: ago(10), headRef: "a" },
        { number: 2, title: "ready", url: "u", isDraft: false, createdAt: ago(20), updatedAt: ago(10), headRef: "b" },
      ],
    }),
  ]);
  const byTitle = new Map(snap.tasks.map((t) => [t.title, t.stale]));
  eq(byTitle.get("#1 draft"), false, "draft at 10 idle days is not stale");
  eq(byTitle.get("#2 ready"), true, "ready at 10 idle days is stale");
});

check("only issues assigned to the user become tasks", () => {
  const snap = build([
    repo({
      openIssues: [
        { number: 1, title: "mine", url: "u", labels: [], createdAt: ago(5), updatedAt: ago(5), assigned: true },
        { number: 2, title: "someone else's", url: "u", labels: [], createdAt: ago(5), updatedAt: ago(5), assigned: false },
      ],
    }),
  ]);
  eq(snap.tasks.map((t) => t.title), ["#1 mine"], "task titles");
  eq(snap.repos[0].counts.openIssues, 2, "both issues still counted on the card");
});

check("a branch with an open PR is not double-counted", () => {
  const snap = build([
    repo({
      openPRs: [
        { number: 1, title: "pr", url: "u", isDraft: false, createdAt: ago(2), updatedAt: ago(1), headRef: "feat/x" },
      ],
      branches: [
        { name: "feat/x", lastCommit: ago(2), unmergedCommits: 4 },
        { name: "feat/y", lastCommit: ago(2), unmergedCommits: 3 },
      ],
    }),
  ]);
  eq(snap.tasks.length, 2, "task count — feat/x is represented by its PR only");
  eq(
    snap.tasks.filter((t) => t.type === "branch").map((t) => t.title),
    ["feat/y · 3 unmerged"],
    "branch tasks",
  );
});

check("a branch with nothing unmerged is not a task", () => {
  const snap = build([
    repo({ branches: [{ name: "level", lastCommit: ago(2), unmergedCommits: 0 }] }),
  ]);
  eq(snap.tasks.length, 0, "task count");
});

check("stale branches land in attention", () => {
  const snap = build([
    repo({ branches: [{ name: "old/work", lastCommit: ago(40), unmergedCommits: 2 }] }),
  ]);
  eq(snap.attention.length, 1, "attention count");
  eq(snap.summary.needsAttention, 1, "summary.needsAttention");
});

check("tasks are sorted by idle time, longest first", () => {
  const snap = build([
    repo({
      name: "r",
      branches: [
        { name: "b1", lastCommit: ago(3), unmergedCommits: 1 },
        { name: "b2", lastCommit: ago(50), unmergedCommits: 1 },
        { name: "b3", lastCommit: ago(20), unmergedCommits: 1 },
      ],
    }),
  ]);
  eq(snap.tasks.map((t) => t.idleDays), [50, 20, 3], "idle ordering");
});

/* ---------------------------------------------------------------- heatmap */

check("heatmap covers the configured window, oldest first, no gaps", () => {
  const snap = build([repo()]);
  eq(snap.heatmap.length, 365, "heatmap length");
  eq(snap.heatmap[364].date, "2026-08-05", "last day is today");
  eq(snap.heatmap[0].date, "2025-08-06", "first day is 364 days back");
  const gaps = snap.heatmap.filter(
    (h, i) => i > 0 && Date.parse(h.date) - Date.parse(snap.heatmap[i - 1].date) !== DAY,
  );
  eq(gaps.length, 0, "consecutive days");
});

check("heatmap aggregates commits across repos onto the right day", () => {
  const snap = build([
    repo({ name: "a", commitDates: [ago(1), ago(1), ago(10)] }),
    repo({ name: "b", commitDates: [ago(1)] }),
  ]);
  const byDate = Object.fromEntries(snap.heatmap.map((h) => [h.date, h.count]));
  eq(byDate["2026-08-04"], 3, "yesterday's count");
  eq(byDate["2026-07-26"], 1, "ten days back");
  eq(byDate["2026-08-05"], 0, "today's count");
});

check("commits older than the window are dropped from the heatmap", () => {
  const snap = build([repo({ commitDates: [ago(400), ago(1)] })]);
  eq(snap.heatmap.reduce((n, h) => n + h.count, 0), 1, "total counted");
});

/* ---------------------------------------------------------------- summary */

check("summary aggregates across repos", () => {
  const snap = build([
    repo({
      name: "a",
      pushedAt: ago(1),
      commitDates: [ago(1), ago(2)],
      openPRs: [{ number: 1, title: "p", url: "u", isDraft: false, createdAt: ago(1), updatedAt: ago(1), headRef: "x" }],
      openIssues: [{ number: 2, title: "i", url: "u", labels: [], createdAt: ago(1), updatedAt: ago(1), assigned: true }],
    }),
    repo({ name: "b", pushedAt: ago(300) }),
  ]);
  eq(
    snap.summary,
    { repos: 2, activeRepos: 1, openPRs: 1, openIssues: 1, commits7d: 2, needsAttention: 0 },
    "summary",
  );
});

/* ------------------------------------------------------------- invariants */

check("a fully populated snapshot passes assertSnapshot", () => {
  const snap = build([
    repo({
      name: "full",
      description: "everything at once",
      language: "TypeScript",
      pushedAt: ago(0.3),
      commits: [{ sha: "abc1234", message: "do a thing", date: ago(0.3), url: "u" }],
      commitDates: [ago(0.3), ago(2), ago(40)],
      openPRs: [
        { number: 7, title: "pr", url: "u", isDraft: false, createdAt: ago(30), updatedAt: ago(30), reviewDecision: "CHANGES_REQUESTED", additions: 10, deletions: 2, headRef: "feat/a" },
      ],
      openIssues: [
        { number: 8, title: "issue", url: "u", labels: ["bug"], createdAt: ago(60), updatedAt: ago(60), assigned: true },
      ],
      branches: [{ name: "feat/b", lastCommit: ago(30), unmergedCommits: 5 }],
    }),
    repo({ name: "quiet", pushedAt: ago(200) }),
  ]);
  assertSnapshot(snap);
  eq(snap.scope, "public", "scope");
  eq(snap.user, "tester", "user");
  ok(snap.sample === undefined, "no sample flag");
  eq(snap.attention.length, 3, "all three items stale");
});

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
