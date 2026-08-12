# Repo Radar

A single-page dashboard of activity across my **public** GitHub repos — commits, open
PRs, issues, and live branches — so every in-flight task is visible in one place.

Data is collected by a scheduled GitHub Action, committed as a static JSON file, and
rendered by a dependency-free `index.html`. No API keys in the browser, no build step,
no rate limits for visitors.

---

## Public repos only

**GitHub Pages sites are public.** Repository visibility and site visibility are
separate settings — a Pages site published from a private repo is still readable by
anyone with the URL. Access-controlled Pages requires GitHub Enterprise Cloud.

So this dashboard doesn't collect private repos at all. Not redacted, not counted —
absent. There is deliberately **no config flag to include them**, because that flag
would make publishing private repo names, branch names, and PR titles to the open
internet a one-character change.

The exclusion holds in three independent places:

1. the GraphQL query asks for `privacy: PUBLIC`, so the API never sends private repos;
2. it queries `user(login:)` rather than `viewer`, so even a broadly-scoped token
   yields only that user's public repos;
3. `derive.mjs` drops anything flagged private, `assertSnapshot` refuses to write a
   snapshot containing one, and the workflow greps the committed file as a last check.

If you want private repos on a dashboard later, the honest options are to accept the
exposure knowingly, or to move the deploy somewhere with real auth in front
(Cloudflare Pages, Netlify) and keep GitHub Actions as the collector.

Public repos you'd still rather not show up: add them to `hide` in `config.json`.

**`repo-radar` hides itself.** A dashboard that reports on the repo it lives in spends
its attention on its own 6-hourly snapshot commits. Two earlier fixes chased symptoms of
that — bot commits excluded from the counts, then `lastActivityAt` replacing `pushedAt`
so its own pushes stopped refreshing its status. Hiding it removes the cause. A useful
side effect: the snapshot no longer changes just because the collector ran, so a genuinely
quiet cron tick can finally produce a byte-identical file and skip the commit.

---

## Status

- [x] **Phase 1** — scaffold, page renders, Pages deploys
- [x] **Phase 2** — `scripts/collect.mjs` against the real GitHub GraphQL API,
      public-only, `hide`/`pin`/`statusOverrides` wired up
- [x] **Phase 3** — dashboard polish: heatmap month/weekday labels, even card heights,
      per-repo sparklines, dormant repos collapsed behind a toggle
- [ ] **Phase 4** — task view refinements (group-by-repo toggle, per-repo notes)
- [ ] **Phase 5** — verification pass on the live cron

---

## Setup

### 1. Create the token

**Create it:** [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
(or Profile → Settings → Developer settings → Personal access tokens → Fine-grained tokens
→ *Generate new token*).

| Field | Value |
|---|---|
| Token name | `repo-radar` |
| Resource owner | `joseph-robert-f` |
| Expiration | 1 year (the max) — set a calendar reminder |
| Repository access | **Public repositories (read-only)** |
| Repository permissions | Metadata: **Read-only** (auto-selected) |

Because the collector only ever reads public data, the *Public repositories (read-only)*
preset is enough — you don't need to grant access to all repositories, and nothing here
needs write. If you use the "All repositories" option instead, the query still filters
to public; the narrower grant just means a leaked token can't do more than the
dashboard could.

**Save it:** in **this repo** →
`https://github.com/joseph-robert-f/repo-radar/settings/secrets/actions` →
**New repository secret**

| Field | Value |
|---|---|
| Name | `DASHBOARD_TOKEN` |
| Secret | paste the `github_pat_…` string |

GitHub shows the token value exactly once, at creation. Once saved it's write-only and
masked in Actions logs.

Do **not** put the token in `config.json`, a `.env`, or any file in this repo — those
get committed and published.

> The workflow falls back to the built-in `github.token` if `DASHBOARD_TOKEN` isn't set.
> That token is scoped to this repository, so cross-repo results may be incomplete —
> set the secret for a full dashboard.

### 2. Enable Pages

Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.

### 3. Run it

Actions → **Collect and deploy** → **Run workflow**. It collects, commits
`data/snapshot.json` if anything changed, and (on `main`) deploys to
`https://joseph-robert-f.github.io/repo-radar/`.

After that it runs itself every 6 hours.

---

## Local use

```bash
node scripts/selftest.mjs                    # offline tests for the derivation logic
DASHBOARD_TOKEN=github_pat_… node scripts/collect.mjs --dry-run
DASHBOARD_TOKEN=github_pat_… node scripts/collect.mjs
python3 -m http.server 8000                  # then open http://localhost:8000
```

After touching a GraphQL query, check it against GitHub's published schema — this
catches a typo'd field or a retired enum without a token or a workflow run:

```bash
npm i --no-save @octokit/graphql-schema graphql
node scripts/validate-queries.mjs
```

Those are the only dependencies anywhere in the project, they're dev-only, and
`--no-save` keeps them out of the repo (there is no `package.json`).

Opening `index.html` via `file://` won't work — browsers block the `fetch` of
`data/snapshot.json`. The page tells you this if you try.

---

## Layout

```
index.html                    the entire dashboard — inline CSS + JS, no deps
config.json                   the only file you hand-edit
data/snapshot.json            generated; what the page reads
scripts/collect.mjs           fetches from the GraphQL API, writes the snapshot
scripts/derive.mjs            pure logic: status, staleness, tasks, heatmap
scripts/selftest.mjs          offline tests for derive.mjs — no network
scripts/validate-queries.mjs  checks the GraphQL documents against GitHub's schema
.github/workflows/pages.yml   collect on a 6h cron, then deploy from main
```

## `config.json`

| Key | What it does |
|---|---|
| `username` | The GitHub handle whose public repos get collected |
| `includeForks` | Include repos you forked (default `false` — usually noise) |
| `includeArchived` | Include archived repos (default `false`) |
| `hide` | Repo names to omit entirely |
| `pin` | Repo names to sort to the top, in this order |
| `statusOverrides` | Force a repo's status, e.g. `{"old-thing": "dormant"}` |
| `branchIgnore` | Glob patterns (`*` only) for branches that shouldn't become tasks — agent and scheduled-job scratch. They still count on the repo card |
| `minUnmergedCommits` | A branch must be at least this far ahead to become a task. Default `1`, i.e. off — raise it to hide one-commit branches, but note that catches genuine parked fixes too |
| `lookback.commitsPerRepo` | How many recent commits to show on a card |
| `lookback.heatmapWeeks` | Heatmap window (52 → 365 days) |
| `lookback.sparkDays` | Days in each card's sparkline (default 30) |
| `staleDays` | Idle-day thresholds that flag a PR / draft / branch / issue |
| `statusThresholdDays` | Day cutoffs for hot / active / idle (past `idle` is dormant) |

## Snapshot schema

`data/snapshot.json` is the contract between collector and page:

```
generatedAt        ISO timestamp — the page warns if >24h old
user               GitHub handle
scope              always "public"
summary            { repos, activeRepos, openPRs, openIssues, commits7d, needsAttention }
repos[]            { name, url, description, language, isFork, isArchived, defaultBranch,
                     lastActivityAt, status, pinned, daily[],
                     commits[], openPRs[], openIssues[], branches[], counts{} }
  commits[]        { sha, message, date, url }
  openPRs[]        { number, title, url, isDraft, createdAt, updatedAt,
                     reviewDecision, additions, deletions, headRef }
  openIssues[]     { number, title, url, labels[], createdAt, updatedAt, assigned }
  branches[]       { name, lastCommit, unmergedCommits }
  daily            30 daily commit counts, oldest first — the card sparkline
  counts           { commits7d, commits30d, openPRs, openIssues, branches }
tasks[]            flattened cross-repo work items, most-idle first:
                   { type: pr|issue|branch, repo, title, url, createdAt, updatedAt,
                     isDraft?, stale }
attention[]        tasks where stale === true
heatmap[]          { date: "YYYY-MM-DD", count } — 365 entries, oldest first
```

`status` is `hot` (<3d) · `active` (<14d) · `idle` (<60d) · `dormant` (60d+), from
`statusThresholdDays`.

**No elapsed-time values are stored.** "9 days old", "idle 3 days" and the like are
computed by `index.html` at render time from the ISO timestamps above. Two reasons:
storing them would make every collect produce a different file — so the workflow's
"don't commit if nothing changed" check could never fire, and the repo would take a
commit every 6 hours forever — and it would freeze every age at whatever it was when
the collector last ran, so a 6-hour-old snapshot would show 6-hour-stale ages.
`assertSnapshot` fails the build if one of these fields reappears.

`status` and `stale` are the exception and are computed at collect time. They're
threshold crossings rather than continuous drift, so they change rarely, and when
they do it's real news worth a commit. Staleness keys on time since the item last
moved, so a long-running PR that got a commit yesterday isn't flagged and a week-old
one nobody has touched is.

Anything the collector emits must match this shape or the page breaks. `selftest.mjs`
enforces it.
