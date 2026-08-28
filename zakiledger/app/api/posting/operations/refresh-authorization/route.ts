import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createPostingAuthorizationRefreshService } from "@/lib/posting-authorization-refresh";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function validBody(value: unknown): value is { operationIds: string[]; refreshRequestId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.operationIds) || body.operationIds.length < 1 || body.operationIds.length > 10 ||
      typeof body.refreshRequestId !== "string" || !UUID.test(body.refreshRequestId)) return false;
  const operationIds = body.operationIds;
  return operationIds.every((id): id is string => typeof id === "string" && UUID.test(id)) &&
    new Set(operationIds.map((id) => id.toLowerCase())).size === operationIds.length;
}

/** Refreshes exact posting approvals only; this route has no provider capability. */
export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid authorization refresh request" }, { status: 400 });
  }
  if (!validBody(body)) {
    return NextResponse.json({ error: "Invalid authorization refresh request" }, { status: 400 });
  }

  try {
    const result = await createPostingAuthorizationRefreshService().refresh({
      actorUserId: user.id,
      operationIds: body.operationIds,
      refreshRequestId: body.refreshRequestId,
    });
    if (result.kind === "BLOCKED") {
      const status = result.reasonCode === "ACTOR_UNAUTHORIZED" ? 403 : 409;
      return NextResponse.json(result, { status });
    }
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "AUTHORIZATION_REFRESH_UNAVAILABLE" }, { status: 503 });
  }
}
