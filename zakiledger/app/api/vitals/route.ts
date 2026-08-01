import { NextResponse } from "next/server";

/** Log-only for now: Render's log stream is the dashboard. A metric worse
 * than "good" is logged at warn so it stands out when scanning. */
export async function POST(req: Request) {
  try {
    const m = await req.json();
    const line = `[vitals] ${m.path} ${m.name}=${Math.round(m.value)} (${m.rating})`;
    if (m.rating === "good") console.log(line);
    else console.warn(line);
  } catch {
    /* malformed beacon — nothing to do */
  }
  return NextResponse.json({ ok: true });
}
