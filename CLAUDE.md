# Repo Radar — working notes

Context for anyone (human or agent) picking this up. Last updated at the end of Phase 2.

---

## What this is

A GitHub Pages dashboard showing activity across **joseph-robert-f's public repos** —
commits, open PRs, open issues, and live branches — so every in-flight task is visible
in one place. The point is the thing GitHub itself doesn't give you: a single cross-repo
view of "what am I actually in the middle of."

Owner: `joseph-robert-f` · Repo: `repo-radar` · Target URL: `https://joseph-robert-f.github.io/repo-radar/`

```
cron (6h) → scripts/collect.mjs → GitHub GraphQL API
          → data/snapshot.json (committed)
          → Pages redeploys
          → index.html fetches the JSON and renders
                          ↓
              raw.githubusercontent.com
                          ↓
          repo-radar-paper (a separate repo and a separate Pages site)
```

No API keys in the browser. No build step. No dependencies. The page is one file that
reads one JSON file.

### `data/snapshot.json` has a second consumer — check before you change its shape

**[repo-radar-paper](https://github.com/joseph-robert-f/repo-radar-paper)** renders the
same snapshot as a newspaper front page. It is a separate repository because GitHub
Pages allows one site per repo, and it reads this repo's published snapshot over
`raw.githubusercontent.com` on its own 6-hourly cron. No token, no cross-repo
credentials — that only works because this repo is public.

Two things follow, and both are easy to forget:

- **The snapshot is a published interface now, not a private file.** Renaming or dropping
  a field breaks a site in another repo, and nothing here will fail to tell you. Adding
  fields is safe; the paper ignores what it doesn't know.
- **Anything hidden here is hidden there too.** `hide` currently holds `repo-radar` *and*
  `repo-radar-paper`, both for the same reason — a pipeline that measures its own
  plumbing (see decision 6). Any future repo whose only commits come from this pipeline
  belongs in that list.

The paper keeps its own daily archive under `editions/` and does its own presentation
work; nothing over there needs anything from here except the snapshot.

---

## Current state

| Phase | State |
|---|---|
| 1 — scaffold, Pages deploy workflow | ✅ shipped |
| 2 — real collector, public-only, config wired up | ✅ shipped |
| 3 — dashboard polish | ✅ shipped |
| 4 — task view refinements | ⬜ not started |
| 5 — verification pass on the live cron | ✅ done bar the browser check |

Phase 2 replaced the sample data with a real collector. `scripts/make-sample.mjs` is
gone, and with it the `sample: true` flag and the yellow scaffold banner.

---

## Decisions already made — and why

Don't silently reverse these. Each was chosen against a real alternative.

### 1. Public repos only — and no flag to change that

**GitHub Pages sites are always public.** Repository visibility and site visibility are
separate settings; a Pages site published from a private repo is still readable by
anyone with the URL. Access-controlled Pages requires GitHub Enterprise Cloud, which a
personal account can't get.

The design went through three positions and landed on the strictest: first "private
repos, redacted" (`Private project 1 · 2 open PRs`), then "excluded via
`includePrivateRepos: false`", now **no private data anywhere in the pipeline and no
switch to turn it on**. Each step removes a class of mistake: redaction can have bugs,
and a boolean can be flipped by someone who doesn't know what it publishes.

Concretely: the query filters `privacy: PUBLIC`, it goes through `user(login:)` instead
of `viewer` so token scope can't widen the result, `derive.mjs` drops anything flagged
private, `assertSnapshot` refuses to write such a snapshot, and the workflow greps the
committed file.

**If someone asks for private repos on this dashboard, don't just add the flag back.**
The honest paths are (a) accept the exposure knowingly and say so out loud, or (b) move
the deploy to Cloudflare Pages or Netlify with real auth in front, keeping GitHub
Actions as the collector.

### 2. Scheduled collection, not live browser fetch

The browser never calls the API. A cron job writes a static JSON file. Instant page
loads, no rate limits for visitors, no token exposed client-side.

### 3. GraphQL, not REST

One request covers repos + commits + PRs + issues + branches. REST needs ~5 calls per
repo. The whole collect run costs a handful of points against a 5,000/hour budget.

### 4. Single-file HTML, no framework

`index.html` contains all CSS and JS inline. No npm, no build, no lockfile to rot. Keep
it that way unless there's a concrete reason not to.

### 5. Staleness keys on idle time, not age

A PR open for 90 days that got a commit yesterday is not a problem; a 9-day-old one
nobody has touched is. `stale` therefore keys on time since the item last moved
(`updatedAt`), not time since it opened (`createdAt`). Age-based staleness flagged the
wrong things.

### 5a. The snapshot stores facts, not elapsed time

No `ageInDays`, `idleDays`, or `daysSinceLastPush` in the file — only the ISO
timestamps they'd be derived from. `index.html` does that arithmetic at render time.

This was learned the hard way. The first version stored them, and because they're
recomputed against the wall clock every run, a collect with *zero* new activity still
produced a 200-line diff. The workflow's "only the timestamp moved — not committing"
check strips `generatedAt` before comparing, so it could never fire: the repo was set
to take a snapshot commit every 6 hours forever, which is exactly the empty-commit
spam that check exists to prevent. Storing them also froze every age on the page at
whatever it was when the collector last ran, so a 6-hour-old snapshot showed 6-hour-
stale ages.

`assertSnapshot` now refuses to write a snapshot containing any of those three fields,
and `selftest.mjs` builds the same fixture at two clocks six hours apart and requires
the bytes to match. If you add a derived value, ask whether it drifts with the clock;
if it does, it belongs in the page.

`status` and `stale` are the deliberate exceptions — threshold crossings, not
continuous drift, so they change rarely and a commit is warranted when they do.

### 6. Bot commits don't count — and neither do bot pushes

Commits whose author login ends in `[bot]` are dropped from the heatmap, the recent-
commit list, and `commits7d`. Otherwise this repo's own 6-hourly `chore: refresh
snapshot` commit would show up as a daily streak of activity, which is the dashboard
measuring itself.

That filter wasn't enough on its own. `pushedAt` still moved every 6 hours when the bot
pushed, so repo-radar sat permanently at "hot" and first in the list, and the snapshot
differed on every run — blocking the no-op commit check all over again. So the snapshot
carries **`lastActivityAt`**, not `pushedAt`: the newest of the non-bot default-branch
commits and the surviving work branches, falling back to `pushedAt` only for a repo
with neither. `assertSnapshot` rejects a snapshot that still emits `pushedAt`.

Related trap: the commit preview fetches N commits and *then* drops bots. On this repo
the last N were all bot commits, so the card read "10 commits/7d" with an empty Details
list. `collect.mjs` now over-fetches (`HISTORY_PREVIEW_FACTOR`) and slices after
filtering.

### 6a. Scratch branches aren't tasks

`branchIgnore` (globs) and `minUnmergedCommits` in `config.json` keep agent and
scheduled-job branches out of the task list. They still count on the repo card — they're
real branches, just not work anybody is going to pick up.

This mattered a lot: on the first real look, 24 of 29 tasks were branches and 20 of
those were `claude/eager-clarke-*` in one repo, burying all five genuine open PRs.

`minUnmergedCommits` defaults to **1** (off) on purpose. Raising it to 2 looked
tempting, but on real data its only unique effect was hiding two conventionally-named,
three-month-old branches in Localize-News — exactly the forgotten work this dashboard
is for. The `dependabot/*` branches it would also have caught were already removed by
the "branch has an open PR" de-duplication.


---

## Layout

```
index.html                    the entire dashboard — inline CSS + JS, no deps
config.json                   the only file meant to be hand-edited
data/snapshot.json            generated; what the page reads
scripts/collect.mjs           network + orchestration: GraphQL → normalized repos
scripts/derive.mjs            pure logic: status, staleness, tasks, heatmap, guards
scripts/selftest.mjs          offline tests for derive.mjs — run this before pushing
scripts/validate-queries.mjs  checks the GraphQL documents against GitHub's schema
.github/workflows/pages.yml   collect on a 6h cron, then deploy from main
```

`collect.mjs` and `derive.mjs` are split so the interesting logic is testable without a
token or a network. If you add a rule about what counts as stale, active, or a task, it
goes in `derive.mjs` and gets a test in `selftest.mjs`.

The queries are the one part `selftest.mjs` can't reach, so they get their own check:
`validate-queries.mjs` imports the real query builders from `collect.mjs` and validates
them against GitHub's published SDL. Run it after touching a query. It needs two dev
deps (`npm i --no-save @octokit/graphql-schema graphql`), which is why it isn't part of
the default test run and why the workflow step is `continue-on-error`.

---

## How the collector works

Three GraphQL phases, all paginated and batched:

1. **repos** — `user(login:).repositories(privacy: PUBLIC, ownerAffiliations: [OWNER],
   orderBy: PUSHED_AT DESC)`, 50/page, pulling the last N commits, 20 open PRs, 20 open
   issues, and 50 branch refs per repo.
2. **commit dates** — the 10-commit preview can't fill a year-long heatmap, so a second
   pass fetches `committedDate` only, since the heatmap window, 8 repos aliased per
   request, capped at 600 commits/repo/year (it logs a warning if it hits the cap).
3. **branch leads** — `unmergedCommits` only exists via
   `ref(qualifiedName: default).compare(headRef: branch).aheadBy`, one comparison per
   branch, 40 aliased per request. Branches level with the default branch are dropped.

Then `buildSnapshot()` derives everything the page reads, `assertSnapshot()` checks it,
and it's written to `data/snapshot.json`.

Known limits, all deliberate:

- the heatmap counts default-branch commits only, so work sitting on a feature branch
  doesn't appear until it merges;
- `issues` become tasks only when assigned to the configured user — someone else's
  issue on your repo isn't on your plate, though it still counts on the repo card;
- PRs and issues are capped at 20 each per repo; the counts on the cards reflect what
  was fetched, not an unbounded total.

---

## Snapshot schema

Documented in full in `README.md` under "Snapshot schema". `selftest.mjs` is the
executable version — read it before changing the shape.

---

## Design system — please don't freelance on this

The visuals follow a validated palette. Colors were chosen by rule and checked with a
contrast/CVD validator, not by eye. All of them are CSS custom properties at the top of
`index.html`, declared for light, `prefers-color-scheme: dark`, and `[data-theme]` so
the manual toggle wins over the OS setting.

- **Recency ramp** (hot → dormant) is an *ordinal* scale: one hue, monotone lightness.
  Light `#1c5cab → #2a78d6 → #5598e7 → #86b6ef`; dark is the same hue re-stepped for the
  dark surface. It passes lightness-monotone, adjacent-ΔL, and light-end contrast checks
  in both modes. Don't substitute a red/yellow/green scheme — a dormant repo isn't an
  error, and severity colors would misstate that.
- **Status colors** (`--status-good/warning/serious/critical`) are reserved for state
  and never reused as series colors. They always ship with a text label beside the dot,
  never color alone.
- **Text never wears a data color.** Labels and values use the text tokens; a colored
  dot beside the text carries identity.
- The heatmap uses a sequential blue ramp with a "Less → More" legend and a per-cell
  hover tooltip.

If you add a chart, follow the same discipline: pick the form first, assign color by the
job it does, validate, then style.

### Voice

The page opens with a generated sentence (`stateOfTheWorld()` in `index.html`) saying
what's actually going on — "29 commits this week across 5 repos. 2 things waiting, the
oldest for 95 days in Localize-News." A wall of counts makes the reader do that
synthesis themselves, which is the job the dashboard is supposed to be doing.

It's composed from the data and **never random**: the same snapshot always renders the
same sentence. Resist the urge to add rotating jokes — a line that changes when the data
didn't is a line you stop trusting. Whimsy lives in the phrasing, not in surprise.

Same rule for empty states. "Nothing's rotting" is fine; a different quip on every load
is not.

### Whimsy that's allowed to move

- The logo sweeps once on load, echoing the favicon.
- Tile numbers count up over 650ms, easing out.
- Cards lift 2px on hover; heatmap cells scale 1.5×.
- The all-clear checkmark draws itself in.

All of it sits behind `prefers-reduced-motion: reduce`, which switches off every
animation and transition. If you add motion, add it there too.

### Task glyphs

PR, issue and branch each get a drawn SVG glyph so the rows differ at a glance. They're
inline SVG on `currentColor`, not emoji — emoji render differently on every platform and
can't inherit color. The glyph is redundant with the text label beside it, never the
only signal.

---

## Gotchas

- **`file://` doesn't work.** The page fetches `data/snapshot.json`, which browsers
  block on the file protocol. Use `python3 -m http.server 8000`. The page renders a
  helpful error explaining this rather than failing silently.
- **GraphQL always needs a token**, even for public data — unlike REST, there's no
  anonymous access. Set `DASHBOARD_TOKEN`.
- **Never commit the token.** Not in `config.json`, not in a `.env`. This repo is public.
- **Pushing over HTTPS with a PAT** requires `workflow` scope to touch
  `.github/workflows/`. SSH and GitHub Desktop sidestep it.
- **A quiet stretch genuinely pushes nothing** now that the snapshot holds no
  clock-derived values. Two consequences to keep in mind. Scheduled workflows
  auto-disable after 60 days of *repo* inactivity, so 60 days with no commit to this
  repo and no activity in any tracked repo would switch the cron off — unlikely across
  13 repos, but that's the failure mode. And `generatedAt` no longer tracks "when did
  we last check", only "when did something last change", which is why the page's badge
  reads `Unchanged for N days — nothing new, or the collector is failing` rather than
  asserting a failure it can't distinguish. A genuinely broken collect fails its
  workflow run, and that's the signal that actually reaches you.
- **GitHub's cron drifts hard.** The first scheduled tick was set for 06:00 UTC and ran
  at 08:14. Treat the 6-hour cadence as approximate; don't build anything that assumes
  a tick lands on the hour.
- **Commits pushed by `github.token` don't trigger workflows**, which is why the collect
  job's own push doesn't cause a loop.
- **`deploy-pages` can hang in `deployment_queued` and time out after 10 minutes.** It
  happened on run #5: the artifact uploaded, `configure-pages` succeeded, the
  environment URL resolved, and GitHub's Pages queue simply never picked the
  deployment up. Nothing in the repo to fix — re-run the failed job, or wait for the
  next cron tick, which deploys again anyway. It's only a config problem if it keeps
  happening; the thing to check then is Settings → Pages → Source still reading
  "GitHub Actions". Note the failure mode is benign for visitors: the last successful
  deploy published a matching page and snapshot, so a failed deploy leaves the site
  stale but self-consistent rather than broken.

---

## Verification checklist

- [x] `node scripts/selftest.mjs` passes (34 checks)
- [x] All three GraphQL documents validate against GitHub's published schema
- [x] Page renders in light, dark, and at 390px with no console errors
- [x] Snapshot contains no private repo names, no `redacted`/`sample` flags
- [x] A real collect run returns repo data, not 401
- [x] The workflow succeeds end to end, collect job through deploy
- [x] Rate-limit headroom logged in the workflow output
- [x] The scheduled cron fires and succeeds unattended
- [x] A collect with no new activity produces a byte-identical snapshot (`selftest.mjs`)
- [x] A real cron tick with no new activity commits nothing
- [ ] Pages URL loads with real data

First live run (2026-08-06, run #2 on `main`): 13 public repos, 37 commits/7d, 5 open
PRs, 0 open issues, 26 tasks, 13 needing attention, 312 commits in the heatmap, 0
private repos. 7 GraphQL requests, ~28 points against the 5,000/hour budget. The
snapshot commit landed as `3ad00a2` and deploy went green. Run #4 was the first
unattended cron run and also went green.

**The no-op tick finally happened.** Run #39, an unattended cron at 2026-08-13T07:11Z,
logged `only the timestamp moved — not committing` and still deployed green. That path
could not fire at all before the clock-drift fix (decision 5a) and the `pushedAt` fix
(decision 6), so it is the piece of evidence both of those were really after. Thirty
consecutive green runs at the time of writing.

One consequence to expect and not misread: `generatedAt` in the committed snapshot now
lags the last *check* by however long the quiet stretch is. Ten hours old means ten
hours of nothing happening, not a broken collector. The page's badge is worded for
exactly this.

**The one remaining box.** The deploy job reports success every run, but nobody has ever
fetched the Pages URL. Every environment this has been built in blocks `github.io` at
the network policy — `curl` gets a 403 at the proxy's CONNECT, not from GitHub — so it
needs a human with an ordinary browser to load it once.

---

## Next up

**Phase 4 — task view.** Group-by-repo vs sort-by-idle toggle. Possibly a per-repo notes
file hand-edited by Joe ("blocked on X, next: Y") rendered onto cards.

Phase 3 is done: the heatmap carries month and weekday labels, `grid-auto-rows: 1fr`
levels every card in a row with Details pinned to the baseline, the five-item `.meta`
row was split so the sparkline and "last touched" sit on their own line, and dormant
repos hide behind a *Show N sleeping repos* toggle (skipped when you searched or chose
the Dormant filter, since then you went looking for them).

Sparklines needed a schema addition: `repos[].daily`, 30 daily commit counts. Like the
heatmap it's a rolling window, so it shifts once a day rather than on every run — the
byte-stability rule in decision 5a still holds within a UTC day, which is what the
no-op-commit check depends on.

**Later.** Daily snapshot history for trend sparklines · "copy last 24h as markdown"
standup export · weekly digest via a second workflow · extend to repos Joe contributes
to rather than owns.

**Housekeeping, found by a systems check on 2026-08-13 and not yet done.** None of it is
breaking anything today.

- `actions/checkout@v4` and `actions/setup-node@v4` target Node 20, which GitHub has
  deprecated; every run is already being forced onto Node 24 and warns about it. `@v5`
  of both is the fix. Same warning applies to `configure-pages@v5` in the paper repo.
- This repo's GitHub description still reads *"Phase 1: scaffold, sample data, Pages
  deploy"*, which has been wrong since Phase 2. `repo-radar-paper` has no description at
  all.
- Three merged branches are still on the remote here — `claude/repo-radar-phase-2-duj0g4`,
  `claude/repo-radar-hide-self-duj0g4`, `claude/repo-radar-newspaper-duj0g4` — plus
  `claude/paper-sprint-3-set-in-type` over in the paper repo. They cost nothing but
  clutter; note that agent sandboxes here cannot delete remote branches (the push is
  refused and reports "Everything up-to-date"), so this one needs a human or the GitHub
  UI.
