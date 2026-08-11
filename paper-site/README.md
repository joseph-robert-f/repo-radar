# The Repo Radar — broadsheet edition

A newspaper front page of activity across [joseph-robert-f](https://github.com/joseph-robert-f)'s
public repositories. One project per article; where a story sits and how big it runs is
the data.

**Live:** https://joseph-robert-f.github.io/repo-radar-paper/
**Data view:** https://joseph-robert-f.github.io/repo-radar/

---

## This repository is presentation only

Nothing here talks to the GitHub API. The collecting happens in
[`repo-radar`](https://github.com/joseph-robert-f/repo-radar), which publishes
`data/snapshot.json`; this repo fetches that file, commits it when it has actually
changed, and deploys the page.

```
repo-radar          collects every 6h  →  data/snapshot.json
        ↓ raw.githubusercontent.com (public, no auth)
repo-radar-paper    fetches, commits if changed, deploys Pages
```

Two consequences worth knowing:

- **No secrets.** `repo-radar` is public, so its snapshot is readable with no
  credentials at all. There is no deploy key, no PAT, nothing to rotate.
- **Visitors never call GitHub.** The page reads a static file sitting beside it, same
  as the dashboard does. No API keys in the browser, no rate limits for readers.

The workflow runs on a cron offset from `repo-radar`'s so it picks up fresh data rather
than racing it, and it skips the commit when only the timestamp moved.

---

## Placement is the data

| Placement | Who gets it |
|---|---|
| Lead — full column width, largest engraving, two-column body | the most recently active project |
| Second front — a third of the page each | the next two |
| Standard — smaller engraving | remaining live projects |
| In Brief — one line, no art | dormant projects |
| Stop Press — boxed, top of the rail | anything stale |
| The Year in Weather | the commit heatmap, with month labels |

Headlines, decks and body copy are generated from the snapshot. Each category carries
several phrasings, picked by a hash of the repo's name, so a page with four quiet
projects doesn't print the same headline four times — but the same snapshot always sets
the same page. Nothing is random, because a line that changes when the data didn't is a
line you stop trusting.

## The engravings

Every article gets one, and they are **drawn in code** rather than produced by an image
model. Each is seeded from a hash of the repo's name — six woodcut motifs plus halftone
and hatching — so it is stable forever and any repo added later gets its own with no
manual step. Ink weight follows `status`, so a busy project looks heavily worked and a
dormant one looks faint: the picture carries the same signal as the placement.

No image files, no API, no build step, and nothing to regenerate on a schedule.

## Layout

```
index.html                       the whole front page — inline CSS + JS, no deps
data/snapshot.json               fetched from repo-radar; what the page reads
.github/workflows/publish.yml    fetch, commit if changed, deploy Pages
```

## Local preview

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

`file://` won't work — browsers block the `fetch` of `data/snapshot.json`. The page says
so if you try.

## Setup, once

Settings → Pages → Build and deployment → **Source: GitHub Actions**. That's all; the
workflow does the rest and needs no secrets.
