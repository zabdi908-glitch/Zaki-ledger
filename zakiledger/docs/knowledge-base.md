# Zaki Ledger — Knowledge Base (the project's memory)

> **What this is:** the single home for distilled external insight — YouTube (via Gemini),
> articles, and real bookkeeper conversations — that should shape our strategy, product, and
> outreach. **This repo is the project's memory; this file is where new learning lands.** Claude
> reads it (alongside the playbook) when generating strategy/outreach, so the outputs get sharper
> over time. That's the "agent as memory" idea — already how we work, now with a front door.

## The architecture (how the memory actually works)
- **The repo is the memory:** `PLAYBOOK.md` (strategy), `prospects.md` (GTM list), `content/`
  (LinkedIn), `prompts/` (master + system prompts), and **this file** (external learning).
- **The master prompt is the index** — it tells any AI (Claude, ChatGPT, Gemini) who we are and
  where the knowledge lives.
- **Claude is the agent** — reads these docs and produces strategy, outreach and content grounded
  in them.
- **Gemini is the intake tool for video** — it can watch a YouTube link natively; you paste the
  summary into the queue below, and Claude distils it into an entry + folds the useful parts into
  the playbook.

## Rules (so this stays an asset, not noise)
1. **Relevance gate:** only add something if it changes a decision or improves an output. If you
   can't say how it applies to Zaki Ledger, it doesn't go in.
2. **Distil, don't dump:** 2–4 lines per entry — the insight + how we use it + the source link.
3. **Just-in-time, not just-in-case:** add when it's useful, not on a schedule. Quality over volume.
   (This is why we killed the "5 videos a day" idea — a firehose you never act on is a liability.)
4. **Every entry gets an action.** An insight that changes nothing is trivia.

## Intake queue (paste Gemini summaries here → Claude files them)
_Empty. Drop a video summary here and say "process the queue"._

## Entries

### Template
- **Source:** [title + link]
- **Insight:** …
- **How we use it:** …(which doc/decision it changes)
- **Action:** …

### Applied
- **Source:** Dan Martell — "The Only 5 Videos You Need" (YouTube playlist).
  **Insight:** PSL content, 4R outreach, the C's of leverage, enterprise-value/LTV, 6-phase scaling.
  **How we use it:** distilled into `PLAYBOOK.md` §5, cross-linked to pricing/outreach/first-10.
  **Action:** done — informs the content bank and outreach system prompt.
