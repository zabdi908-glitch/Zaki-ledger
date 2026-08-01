import { NextResponse } from "next/server";
import { z } from "zod/v4";

const METRIC_NAMES = ["LCP", "CLS", "INP", "FCP", "TTFB"] as const;
const RATINGS = ["good", "needs-improvement", "poor"] as const;

const BodySchema = z.object({
  path: z.string(),
  name: z.enum(METRIC_NAMES),
  rating: z.enum(RATINGS),
  value: z.number().finite(),
});

/** Log-only for now: Render's log stream is the dashboard. A metric worse
 * than "good" is logged at warn so it stands out when scanning.
 *
 * Unauthenticated by design — vitals beacons fire from any client — so the
 * body is untrusted input. It's validated against an allowlist of known
 * metric names/ratings before it ever reaches the log line, and `path` is
 * stripped of newlines and capped in length, so a caller can't inject a
 * fake `[vitals] ...` line into the log stream. Malformed payloads are
 * dropped with a bare 204: no log line (it's noise, not an incident) and no
 * body that would hint at what was wrong with it. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return new NextResponse(null, { status: 204 });
  }
  const m = parsed.data;
  const path = m.path.replace(/[\r\n]/g, "").slice(0, 120);
  const line = `[vitals] ${path} ${m.name}=${Math.round(m.value)} (${m.rating})`;
  if (m.rating === "good") console.log(line);
  else console.warn(line);
  return NextResponse.json({ ok: true });
}
