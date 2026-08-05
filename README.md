# Repo Radar

A single-page dashboard of activity across all my GitHub repos — commits, open PRs,
issues, and live branches — so every in-flight task is visible in one place.

Data is collected by a scheduled GitHub Action, committed as a static JSON file, and
rendered by a dependency-free `index.html`. No API keys in the browser, no build step,
no rate limits for visitors.

---

## ⚠️ Read this before enabling Pages

**GitHub Pages sites are public.** Repository visibility and site visibility are
separate settings — a Pages site published from a private repo is still readable by
anyone with the URL. Access-controlled Pages requires GitHub Enterprise Cloud.

This repo therefore ships with **`redactPrivateRepos: true`** in `config.json`.
Private repos appear as `Private project 1 · 2 open PRs · last push 1d ago` — counts
and timing only. Names, branch names, PR titles, and issue titles are stripped **in
the collector**, so they never reach `data/snapshot.json` and never get committed.

If you flip that flag to `false`, private repo details become public. Don't do it on a
Pages deploy unless you're certain nothing sensitive is in a repo name.

---

## Status

- [x] **Phase 1** — scaffold, sample data, page renders, Pages deploys
- [ ] **Phase 2** — `scripts/collect.mjs` against the real GitHub GraphQL API
- [ ] **Phase 3** — dashboard polish
- [ ] **Phase 4** — unified task view refinements
- [ ] **Phase 5** — cron automation + verification pass

---

## Phase 1 setup (~10 min)

### 1. Create the repo and push

```bash
gh repo create repo-radar --public --source=. --remote=origin --push
# or, without gh:
#   git init && git add -A && git commit -m "Phase 1 scaffold"
#   git branch -M main
#   git remote add origin git@github.com:<you>/repo-radar.git && git push -u origin main
```

### 2. Enable Pages

Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.

That's it — no branch to pick. The workflow in `.github/workflows/pages.yml` fires on
push to `main` and deploys.

### 3. Confirm it worked

Watch the **Actions** tab. When the `Deploy Pages` run goes green it prints the URL —
usually `https://<you>.github.io/repo-radar/`. You should see the dashboard with a
yellow "Scaffold data" banner at the top.

**If you see the banner, Phase 1 is done.** The pipeline works; everything after this
is swapping fake data for real data.

### 4. Create the token (needed for Phase 2)

**Create it:** [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
(or Profile → Settings → Developer settings → Personal access tokens → Fine-grained tokens
→ *Generate new token*).

| Field | Value |
|---|---|
| Token name | `repo-radar` |
| Resource owner | `joseph-robert-f` |
| Expiration | 1 year (the max) — set a calendar reminder |
| Repository access | **All repositories** |
| Repository permissions | Metadata: **Read-only** (auto-selected) · Contents: **Read-only** · Pull requests: **Read-only** · Issues: **Read-only** |

Leave every other permission at *No access*. Nothing here needs write.

**Save it:** in **this repo** (not your account settings) →
`https://github.com/joseph-robert-f/repo-radar/settings/secrets/actions` →
**New repository secret**

| Field | Value |
|---|---|
| Name | `DASHBOARD_TOKEN` |
| Secret | paste the `github_pat_…` string |

GitHub shows the token value exactly once, at creation. Copy it straight into the
secret. Once saved it's write-only — nobody, including you, can read it back, and it's
masked in Actions logs.

Do **not** put the token in `config.json`, a `.env`, or any file in this repo — those
get committed and published.

---

## Local preview

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` via `file://` won't work — browsers block the `fetch` of
`data/snapshot.json`. The page tells you this if you try.

Regenerate the sample data (dates are relative to when you run it):

```bash
node scripts/make-sample.mjs
```

---

## Layout

```
index.html                    the entire dashboard — inline CSS + JS, no deps
config.json                   the only file you hand-edit
data/snapshot.json            generated; what the page reads
scripts/make-sample.mjs       Phase 1 fake-data generator (delete after Phase 2)
scripts/collect.mjs           Phase 2 — the real collector
.github/workflows/pages.yml   deploy; Phase 5 adds the collect job
```

## `config.json`

| Key | What it does |
|---|---|
| `username` | Your GitHub handle |
| `redactPrivateRepos` | Strip private repo names/titles in the collector. **Leave `true` for a public Pages deploy.** |
| `hide` | Repo names to omit entirely |
| `pin` | Repo names to always sort to the top |
| `statusOverrides` | Force a repo's status, e.g. `{"old-thing": "archived"}` |
| `staleDays` | Age thresholds that flag a PR / draft / branch / issue as needing attention |
| `statusThresholdDays` | Day cutoffs for hot / active / idle (past `idle` is dormant) |

## Snapshot schema

`data/snapshot.json` is the contract between collector and page:

```
generatedAt        ISO timestamp — the page shows a warning if >24h old
user               GitHub handle
redactionEnabled   bool, mirrors config
summary            { repos, activeRepos, openPRs, openIssues, commits7d, needsAttention }
repos[]            { name, url, isPrivate, redacted, description, language, pushedAt,
                     daysSinceLastPush, status, commits[], openPRs[], openIssues[],
                     branches[], counts{} }
tasks[]            flattened cross-repo work items:
                   { type: pr|issue|branch, repo, title, url, ageInDays, stale }
attention[]        tasks where stale === true
heatmap[]          { date: "YYYY-MM-DD", count } — 365 entries
```

Anything Phase 2's collector emits must match this shape or the page breaks.
