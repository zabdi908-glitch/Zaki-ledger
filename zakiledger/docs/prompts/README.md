# Prompts — Zaki Ledger's reusable AI assets

Built from **PLAYBOOK §5.1** (Dan Martell's "ChatGPT operating system"). The idea: stop
re-explaining the business every time. Capture it **once** as a Master Prompt, then bolt a
task-specific **System Prompt** on top for each job. This is the "Content leverage" from
PLAYBOOK §5.3 — teach the model a thing once, reuse it forever.

## The two layers

| File | Layer | What it does |
|---|---|---|
| `master-prompt.md` | **Master Prompt** | The persistent "who I am / what Zaki Ledger is" context. Paste once. |
| `outreach-system-prompt.md` | **System Prompt** | How to do one job — write 4R cold outreach. Sits on top of the master. |

## How to use (ChatGPT)

**Option A — a Project (simplest):** create a ChatGPT Project → paste `master-prompt.md` into the
Project's custom instructions → start a chat and paste a system prompt for the task at hand.

**Option B — a Custom GPT (most reusable):** create a Custom GPT → put `master-prompt.md` +
`outreach-system-prompt.md` together in its instructions → name it "Zaki Ledger Outreach". Now
every cold-email batch is one message: paste the firm's details, get three variants back.

## Next prompts to add (same pattern)
- **Discovery-Call Debrief** — paste rough notes → structured learnings + follow-up + the one
  override/insight to feed the product.
- **Case-Study Writer** — turn a pilot's saved-hours numbers into the PLAYBOOK's "we gave [firm]
  back X hours/week" story.
- **PSL Content** (PLAYBOOK §5.2) — turn a real pain stat + a discovery story into one
  Point/Story/Lesson clip script for LinkedIn/reels.
