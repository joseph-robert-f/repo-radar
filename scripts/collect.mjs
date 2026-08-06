#!/usr/bin/env node
/**
 * Repo Radar collector — public repos only.
 *
 * Fetches activity across the configured user's PUBLIC repositories from the
 * GitHub GraphQL API and writes data/snapshot.json. Node 20+, zero deps.
 *
 *   DASHBOARD_TOKEN=github_pat_... node scripts/collect.mjs
 *
 * Flags:
 *   --dry-run   fetch and derive, print the summary, write nothing
 *   --out PATH  write somewhere other than data/snapshot.json
 *
 * ---------------------------------------------------------------------------
 * PUBLIC ONLY — this is structural, not a setting.
 *
 * The Pages site this feeds is public (repo visibility and site visibility are
 * separate settings; a site published from a private repo is still readable by
 * anyone with the URL). So private repos are excluded three times over:
 *
 *   1. the query asks for `privacy: PUBLIC`, so the API never sends them;
 *   2. it goes through `user(login:)`, not `viewer`, so a broadly-scoped token
 *      still only yields that user's public repos;
 *   3. anything claiming isPrivate is dropped in derive.mjs and the written
 *      snapshot is asserted clean before it hits disk.
 *
 * There is deliberately no include-private flag. Adding one would make leaking
 * private repo names, branch names, and PR titles to the open internet a
 * one-character change. See CLAUDE.md for the honest paths to private data.
 * ---------------------------------------------------------------------------
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshot, assertSnapshot, DAY } from "./derive.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.github.com/graphql";
const TOKEN = process.env.DASHBOARD_TOKEN || process.env.GITHUB_TOKEN;

const REPO_PAGE = 50; // repos per page — keeps each request well inside the node budget
const HISTORY_PAGE = 100; // commits per history page
const HISTORY_MAX_PAGES = 6; // 600 commits/repo/year before we stop and say so
const HISTORY_BATCH = 8; // repos aliased into one history request
const COMPARE_BATCH = 40; // branch comparisons aliased into one request

const isBot = (login) => !!login && /\[bot\]$/.test(login);

/* -------------------------------------------------------------- transport */

let requestCount = 0;
let lastRateLimit = null;

async function gql(query, variables = {}, attempt = 1) {
  requestCount++;
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "repo-radar-collector",
    },
    body: JSON.stringify({ query, variables }),
  });

  // 502s and secondary rate limits are transient; back off and retry.
  if ((res.status >= 500 || res.status === 403 || res.status === 429) && attempt <= 4) {
    const wait = 2000 * 2 ** (attempt - 1);
    console.warn(`  HTTP ${res.status} — retrying in ${wait / 1000}s (attempt ${attempt}/4)`);
    await new Promise((r) => setTimeout(r, wait));
    return gql(query, variables, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API returned HTTP ${res.status}: ${body.slice(0, 400)}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join("; ");
    throw new Error(`GraphQL error: ${msg}`);
  }
  // Merge rather than replace: every query selects the same rateLimit fields
  // now, but a partial selection anywhere would otherwise blank out limit and
  // resetAt in the final log line.
  if (json.data?.rateLimit) lastRateLimit = { ...lastRateLimit, ...json.data.rateLimit };
  return json.data;
}

/* ------------------------------------------------------- phase 1: repos */

export const REPOS_QUERY = `
query Repos($login: String!, $cursor: String, $page: Int!, $commits: Int!) {
  rateLimit { limit cost remaining resetAt }
  user(login: $login) {
    login
    repositories(
      first: $page
      after: $cursor
      privacy: PUBLIC
      ownerAffiliations: [OWNER]
      orderBy: { field: PUSHED_AT, direction: DESC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        url
        description
        isPrivate
        isFork
        isArchived
        pushedAt
        primaryLanguage { name }
        defaultBranchRef {
          name
          target {
            ... on Commit {
              history(first: $commits) {
                nodes {
                  oid
                  messageHeadline
                  committedDate
                  url
                  author { user { login } }
                }
              }
            }
          }
        }
        pullRequests(states: OPEN, first: 20, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes {
            number title url isDraft createdAt updatedAt
            reviewDecision additions deletions headRefName
          }
        }
        issues(states: OPEN, first: 20, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes {
            number title url createdAt updatedAt
            labels(first: 8) { nodes { name } }
            assignees(first: 5) { nodes { login } }
          }
        }
        refs(refPrefix: "refs/heads/", first: 50, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
          nodes {
            name
            target { ... on Commit { oid committedDate } }
          }
        }
      }
    }
  }
}`;

async function fetchRepos(login, commitsPerRepo) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await gql(REPOS_QUERY, {
      login,
      cursor,
      page: REPO_PAGE,
      commits: commitsPerRepo,
    });
    const user = data.user;
    if (!user) throw new Error(`no such GitHub user: ${login}`);
    out.push(...user.repositories.nodes);
    const { hasNextPage, endCursor } = user.repositories.pageInfo;
    if (!hasNextPage) break;
    cursor = endCursor;
  }
  return out;
}

/** Turn a raw GraphQL repo node into the shape derive.mjs wants. */
function normalizeRepo(node, login) {
  const defaultBranch = node.defaultBranchRef?.name ?? null;
  const recent = node.defaultBranchRef?.target?.history?.nodes ?? [];

  return {
    name: node.name,
    url: node.url,
    description: node.description,
    language: node.primaryLanguage?.name ?? null,
    isPrivate: node.isPrivate,
    isFork: node.isFork,
    isArchived: node.isArchived,
    pushedAt: node.pushedAt,
    defaultBranch,
    commits: recent
      .filter((c) => !isBot(c.author?.user?.login))
      .map((c) => ({
        sha: c.oid.slice(0, 7),
        message: c.messageHeadline,
        date: c.committedDate,
        url: c.url,
      })),
    openPRs: (node.pullRequests?.nodes ?? []).map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      isDraft: p.isDraft,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      reviewDecision: p.reviewDecision,
      additions: p.additions,
      deletions: p.deletions,
      headRef: p.headRefName,
    })),
    openIssues: (node.issues?.nodes ?? []).map((i) => ({
      number: i.number,
      title: i.title,
      url: i.url,
      labels: (i.labels?.nodes ?? []).map((l) => l.name),
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      // "assigned" means assigned to the dashboard's owner — someone else's
      // issue on your repo is not on your plate.
      assigned: (i.assignees?.nodes ?? []).some((a) => a.login === login),
    })),
    // Branch list is filled in by fetchBranchLeads: we only keep non-default
    // branches, and only once we know how far ahead each one is.
    branches: (node.refs?.nodes ?? [])
      .filter((r) => r.name !== defaultBranch && r.target?.committedDate)
      .map((r) => ({
        name: r.name,
        lastCommit: r.target.committedDate,
        unmergedCommits: 0,
      })),
    commitDates: [],
  };
}

/* --------------------------------------------- phase 2: year of commits */

/** One aliased `history` block per repo in the batch. */
export function buildHistoryQuery(count) {
  const decls = ["$login: String!", "$since: GitTimestamp!", "$page: Int!"];
  const parts = [];
  for (let n = 0; n < count; n++) {
    decls.push(`$n${n}: String!`, `$c${n}: String`);
    parts.push(`
  r${n}: repository(owner: $login, name: $n${n}) {
    defaultBranchRef { target { ... on Commit {
      history(first: $page, since: $since, after: $c${n}) {
        pageInfo { hasNextPage endCursor }
        nodes { committedDate author { user { login } } }
      }
    } } }
  }`);
  }
  return `query Hist(${decls.join(", ")}) {\n  rateLimit { limit cost remaining resetAt }${parts.join("")}\n}`;
}

/**
 * The heatmap needs a year of daily counts, which the 10-commit preview above
 * can't supply. Fetch dates only (cheap fields) for every repo, several repos
 * per request, paginating each until it runs out or hits the page cap.
 */
async function fetchCommitDates(login, repos, since) {
  const state = new Map(
    repos.map((r) => [r.name, { cursor: null, done: false, pages: 0, dates: [] }]),
  );
  const capped = [];

  for (let i = 0; i < repos.length; i += HISTORY_BATCH) {
    const batch = repos.slice(i, i + HISTORY_BATCH);
    let live = batch.filter((r) => !state.get(r.name).done);

    while (live.length) {
      const vars = { login, since, page: HISTORY_PAGE };
      live.forEach((r, n) => {
        vars[`n${n}`] = r.name;
        vars[`c${n}`] = state.get(r.name).cursor;
      });

      const data = await gql(buildHistoryQuery(live.length), vars);

      const next = [];
      live.forEach((r, n) => {
        const st = state.get(r.name);
        const hist = data[`r${n}`]?.defaultBranchRef?.target?.history;
        if (!hist) {
          st.done = true;
          return;
        }
        for (const c of hist.nodes) {
          if (!isBot(c.author?.user?.login)) st.dates.push(c.committedDate);
        }
        st.pages++;
        if (hist.pageInfo.hasNextPage && st.pages < HISTORY_MAX_PAGES) {
          st.cursor = hist.pageInfo.endCursor;
          next.push(r);
        } else {
          if (hist.pageInfo.hasNextPage) capped.push(r.name);
          st.done = true;
        }
      });
      live = next;
    }
  }

  for (const r of repos) r.commitDates = state.get(r.name).dates;
  if (capped.length) {
    console.warn(
      `  note: hit the ${HISTORY_PAGE * HISTORY_MAX_PAGES}-commit/year cap on ${capped.join(", ")} — ` +
        `heatmap undercounts the oldest days for those repos`,
    );
  }
}

/* ------------------------------------------- phase 3: how far ahead? */

/** One aliased default-branch-vs-branch comparison per job in the batch. */
export function buildCompareQuery(count) {
  const decls = ["$login: String!"];
  const parts = [];
  for (let n = 0; n < count; n++) {
    decls.push(`$n${n}: String!`, `$q${n}: String!`, `$h${n}: String!`);
    parts.push(`
  c${n}: repository(owner: $login, name: $n${n}) {
    ref(qualifiedName: $q${n}) { compare(headRef: $h${n}) { aheadBy } }
  }`);
  }
  return `query Cmp(${decls.join(", ")}) {\n  rateLimit { limit cost remaining resetAt }${parts.join("")}\n}`;
}

/**
 * `unmergedCommits` is the number this dashboard exists for: work sitting on a
 * branch that hasn't landed. The API only gives it via a comparison against the
 * default branch, one per branch — so batch them heavily.
 */
async function fetchBranchLeads(login, repos) {
  const jobs = [];
  for (const r of repos) {
    if (!r.defaultBranch) continue;
    for (const b of r.branches) jobs.push({ repo: r, branch: b });
  }

  for (let i = 0; i < jobs.length; i += COMPARE_BATCH) {
    const batch = jobs.slice(i, i + COMPARE_BATCH);
    const vars = { login };
    batch.forEach((j, n) => {
      vars[`n${n}`] = j.repo.name;
      vars[`q${n}`] = `refs/heads/${j.repo.defaultBranch}`;
      vars[`h${n}`] = j.branch.name;
    });

    const data = await gql(buildCompareQuery(batch.length), vars);
    batch.forEach((j, n) => {
      j.branch.unmergedCommits = data[`c${n}`]?.ref?.compare?.aheadBy ?? 0;
    });
  }

  // A branch with nothing ahead of the default branch is merged history, not
  // open work — drop it so it never reaches the task list.
  for (const r of repos) r.branches = r.branches.filter((b) => b.unmergedCommits > 0);
}

/* ------------------------------------------------------------------ main */

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const outFlag = argv.indexOf("--out");
  const outPath = outFlag !== -1 ? argv[outFlag + 1] : `${ROOT}/data/snapshot.json`;

  if (!TOKEN) {
    console.error(
      "No token. Set DASHBOARD_TOKEN (or GITHUB_TOKEN).\n" +
        "The GraphQL API requires authentication even for public data.",
    );
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(`${ROOT}/config.json`, "utf8"));
  const login = config.username;
  const now = Date.now();
  const since = new Date(
    now - ((config.lookback?.heatmapWeeks ?? 52) * 7 + 1) * DAY,
  ).toISOString();

  console.log(`Collecting public repos for ${login}…`);

  const rawNodes = await fetchRepos(login, config.lookback?.commitsPerRepo ?? 10);

  // Belt and braces: privacy:PUBLIC should make this impossible, but if the API
  // ever hands back a private repo we stop rather than publish it.
  const leaked = rawNodes.filter((n) => n.isPrivate);
  if (leaked.length) {
    throw new Error(
      `API returned ${leaked.length} private repo(s) despite privacy:PUBLIC — refusing to continue`,
    );
  }
  console.log(`  ${rawNodes.length} public repos`);

  const repos = rawNodes.map((n) => normalizeRepo(n, login));

  console.log("  fetching a year of commit dates…");
  await fetchCommitDates(login, repos, since);

  console.log("  comparing branches against their default branch…");
  await fetchBranchLeads(login, repos);

  const snapshot = buildSnapshot(repos, config, { user: login, now });
  assertSnapshot(snapshot);

  const s = snapshot.summary;
  console.log(
    `\n${s.repos} repos · ${s.commits7d} commits/7d · ${s.openPRs} open PRs · ` +
      `${s.openIssues} open issues · ${s.needsAttention} needing attention`,
  );
  if (lastRateLimit) {
    console.log(
      `GraphQL: ${requestCount} requests · ${lastRateLimit.remaining}/${lastRateLimit.limit} ` +
        `points remaining · resets ${lastRateLimit.resetAt}`,
    );
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing written");
    return;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`wrote ${outPath}`);
}

// Only run when invoked directly — the query builders above are imported by
// scripts/validate-queries.mjs, which must not trigger a collect.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\ncollect failed: ${err.message}`);
    process.exit(1);
  });
}
