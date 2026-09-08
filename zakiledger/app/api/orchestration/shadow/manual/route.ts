import { requireUser } from "@/lib/auth";
import { createManualShadowRuntime, invokeManualShadow } from "@/lib/orchestration/manual-shadow-entrypoint";

/** Authenticated, operator-scoped, one-shot SHADOW orchestration. It schedules nothing. */
export async function POST(request: Request) {
  return invokeManualShadow(request, {
    authenticate: requireUser,
    runtime: createManualShadowRuntime,
  });
}
