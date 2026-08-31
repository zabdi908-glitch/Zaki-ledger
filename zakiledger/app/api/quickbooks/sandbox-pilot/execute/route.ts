import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import {
  createQuickBooksSandboxPilotExecutor,
  type QuickBooksSandboxPilotInput,
} from "@/lib/quickbooks-sandbox-pilot-executor";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[^\u0000-\u001f\u007f]{1,100}$/;

/** Authenticated, explicit-ID, Sandbox-only execution of one Step-5 operation pair. */
export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let input: QuickBooksSandboxPilotInput;
  try {
    input = await request.json() as QuickBooksSandboxPilotInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!UUID.test(input?.vendorOperationId ?? "") ||
      !UUID.test(input?.billOperationId ?? "") ||
      input.vendorOperationId === input.billOperationId ||
      !PROVIDER_ID.test(input?.externalVendorId?.trim() ?? "")) {
    return NextResponse.json({ error: "Invalid Sandbox pilot identifiers" }, { status: 400 });
  }

  try {
    const result = await createQuickBooksSandboxPilotExecutor().execute(
      { ...input, externalVendorId: input.externalVendorId.trim() },
      { kind: "USER", userId: user.id },
    );
    return NextResponse.json(result, { status: result.verdict === "SUCCEEDED" ? 200 : 409 });
  } catch {
    return NextResponse.json(
      { error: "SANDBOX_PILOT_FAILED_CLOSED" },
      { status: 503 },
    );
  }
}
