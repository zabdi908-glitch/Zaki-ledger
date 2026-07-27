# Live-check fixtures

Drop **real** documents here, then run `npm run receipts:live` with a live
`ANTHROPIC_API_KEY`. The folder name is the ground-truth label:

- `receipts/` — till receipts, fuel, restaurant, faded thermal, crumpled, ones
  with no receipt number. Variety is the point; 10 clean supermarket receipts
  will report a flattering number that tells you nothing.
- `invoices/` — supplier invoices, including at least one marked **PAID**, which
  is the classic invoice-or-receipt ambiguity.

Accepted: `.png .jpg .jpeg .webp .gif .pdf`

**Do not commit real documents** — they contain supplier names, card digits and
addresses. This directory is gitignored except for this file.
