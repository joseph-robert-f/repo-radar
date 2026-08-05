#!/usr/bin/env node
/**
 * Phase 1 scaffold helper — generates data/snapshot.json with FAKE data.
 *
 * Its only job is to define the schema contract that scripts/collect.mjs
 * (Phase 2) must produce, and to give the page something to render so we can
 * verify GitHub Pages works before writing any real API code.
 *
 * Delete this file once collect.mjs is live.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const now = Date.now();
const DAY = 86400000;
const ago = (d) => new Date(now - d * DAY).toISOString();

const statusFor = (days) =>
  days < 3 ? "hot" : days < 14 ? "active" : days < 60 ? "idle" : "dormant";

const repos = [
  {
    name: "flight-tracker",
    isPrivate: false,
    description: "Live ADS-B ingest + map overlay",
    language: "TypeScript",
    daysAgo: 0.4,
    commits: [
      ["a1b2c3d", "fix: debounce websocket reconnect", 0.4],
      ["b2c3d4e", "feat: altitude color ramp on the map", 1.1],
      ["c3d4e5f", "chore: bump deps", 2.6],
    ],
    prs: [
      { number: 42, title: "Add per-aircraft trail history", draft: false, daysOpen: 11, updated: 2, reviewDecision: "CHANGES_REQUESTED", additions: 412, deletions: 88, headRef: "feat/trails" },
      { number: 45, title: "WIP: switch tile provider", draft: true, daysOpen: 3, updated: 3, reviewDecision: null, additions: 96, deletions: 12, headRef: "spike/tiles" },
    ],
    issues: [
      { number: 38, title: "Map stutters above ~2k aircraft", labels: ["bug", "perf"], daysOpen: 22, updated: 19, assigned: true },
    ],
    branches: [
      { name: "feat/trails", lastCommit: 2, unmergedCommits: 7 },
      { name: "spike/tiles", lastCommit: 3, unmergedCommits: 2 },
    ],
  },
  {
    name: "dotfiles",
    isPrivate: false,
    description: "nvim, zsh, tmux",
    language: "Lua",
    daysAgo: 6,
    commits: [
      ["d4e5f6a", "nvim: swap telescope for fzf-lua", 6],
      ["e5f6a7b", "zsh: faster prompt init", 18],
    ],
    prs: [],
    issues: [],
    branches: [],
  },
  {
    name: "recipe-parser",
    isPrivate: false,
    description: "Scrape and normalize recipe schema.org markup",
    language: "Python",
    daysAgo: 34,
    commits: [["f6a7b8c", "handle nested ingredient groups", 34]],
    prs: [
      { number: 12, title: "Support fractional unicode quantities", draft: false, daysOpen: 41, updated: 34, reviewDecision: null, additions: 133, deletions: 21, headRef: "fractions" },
    ],
    issues: [
      { number: 9, title: "Timeouts on slow sites", labels: ["enhancement"], daysOpen: 60, updated: 55, assigned: true },
    ],
    branches: [{ name: "fractions", lastCommit: 34, unmergedCommits: 4 }],
  },
  {
    name: "REDACTED_1",
    isPrivate: true,
    redacted: true,
    description: null,
    language: null,
    daysAgo: 1.2,
    commits: [],
    commitCount7d: 9,
    prs: [],
    prCount: 2,
    issues: [],
    issueCount: 5,
    branches: [],
    branchCount: 3,
  },
  {
    name: "REDACTED_2",
    isPrivate: true,
    redacted: true,
    description: null,
    language: null,
    daysAgo: 21,
    commits: [],
    commitCount7d: 0,
    prs: [],
    prCount: 1,
    issues: [],
    issueCount: 0,
    branches: [],
    branchCount: 1,
  },
  {
    name: "old-blog",
    isPrivate: false,
    description: "Retired Hugo site",
    language: "HTML",
    daysAgo: 380,
    commits: [["0a1b2c3", "final post", 380]],
    prs: [],
    issues: [],
    branches: [],
  },
];

const USER = "joseph-robert-f";
const out = { generatedAt: new Date(now).toISOString(), user: USER, sample: true, redactionEnabled: true, repos: [], tasks: [], attention: [], heatmap: [] };

for (const r of repos) {
  const url = r.redacted ? null : `https://github.com/${USER}/${r.name}`;
  const repo = {
    name: r.redacted ? r.name.replace("REDACTED_", "Private project ") : r.name,
    url,
    isPrivate: r.isPrivate,
    redacted: !!r.redacted,
    description: r.description,
    language: r.language,
    pushedAt: ago(r.daysAgo),
    daysSinceLastPush: Math.round(r.daysAgo * 10) / 10,
    status: r.statusOverride || statusFor(r.daysAgo),
    commits: (r.commits || []).map(([sha, message, d]) => ({ sha, message, date: ago(d), url: url ? `${url}/commit/${sha}` : null })),
    openPRs: (r.prs || []).map((p) => ({ number: p.number, title: p.title, url: url ? `${url}/pull/${p.number}` : null, isDraft: p.draft, createdAt: ago(p.daysOpen), updatedAt: ago(p.updated), ageInDays: p.daysOpen, reviewDecision: p.reviewDecision, additions: p.additions, deletions: p.deletions, headRef: p.headRef })),
    openIssues: (r.issues || []).map((i) => ({ number: i.number, title: i.title, url: url ? `${url}/issues/${i.number}` : null, labels: i.labels, createdAt: ago(i.daysOpen), updatedAt: ago(i.updated), ageInDays: i.daysOpen, assigned: i.assigned })),
    branches: (r.branches || []).map((b) => ({ name: b.name, lastCommit: ago(b.lastCommit), unmergedCommits: b.unmergedCommits })),
    counts: {
      commits7d: r.commitCount7d ?? (r.commits || []).filter(([, , d]) => d <= 7).length,
      openPRs: r.prCount ?? (r.prs || []).length,
      openIssues: r.issueCount ?? (r.issues || []).length,
      branches: r.branchCount ?? (r.branches || []).length,
    },
  };
  out.repos.push(repo);

  if (repo.redacted) continue;

  for (const p of repo.openPRs) {
    out.tasks.push({ type: "pr", repo: repo.name, title: p.title, url: p.url, ageInDays: p.ageInDays, isDraft: p.isDraft, stale: p.isDraft ? p.ageInDays > 14 : p.ageInDays > 7 });
  }
  for (const i of repo.openIssues.filter((i) => i.assigned)) {
    out.tasks.push({ type: "issue", repo: repo.name, title: i.title, url: i.url, ageInDays: i.ageInDays, stale: i.ageInDays > 30 });
  }
  for (const b of repo.branches) {
    const days = Math.round((now - Date.parse(b.lastCommit)) / DAY);
    if (repo.openPRs.some((p) => p.headRef === b.name)) continue;
    out.tasks.push({ type: "branch", repo: repo.name, title: `${b.name} · ${b.unmergedCommits} unmerged`, url: repo.url ? `${repo.url}/tree/${b.name}` : null, ageInDays: days, stale: days > 14 });
  }
}

out.tasks.sort((a, b) => b.ageInDays - a.ageInDays);
out.attention = out.tasks.filter((t) => t.stale);

out.summary = {
  repos: out.repos.length,
  activeRepos: out.repos.filter((r) => r.status === "hot" || r.status === "active").length,
  openPRs: out.repos.reduce((n, r) => n + r.counts.openPRs, 0),
  openIssues: out.repos.reduce((n, r) => n + r.counts.openIssues, 0),
  commits7d: out.repos.reduce((n, r) => n + r.counts.commits7d, 0),
  needsAttention: out.attention.length,
};

// 52 weeks of fake commit counts, weekday-heavy
for (let i = 364; i >= 0; i--) {
  const d = new Date(now - i * DAY);
  const dow = d.getUTCDay();
  const base = dow === 0 || dow === 6 ? 0.25 : 1;
  const n = Math.max(0, Math.round((Math.sin(i / 23) + 1.1) * 3 * base * ((i % 7) / 7 + 0.4)));
  out.heatmap.push({ date: d.toISOString().slice(0, 10), count: n });
}

mkdirSync(`${ROOT}/data`, { recursive: true });
writeFileSync(`${ROOT}/data/snapshot.json`, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote data/snapshot.json — ${out.repos.length} repos, ${out.tasks.length} tasks, ${out.attention.length} needing attention`);
