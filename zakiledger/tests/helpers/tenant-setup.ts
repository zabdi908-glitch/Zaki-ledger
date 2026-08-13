/**
 * Local two-tenant setup helper: create real Auth users A/B (admin API),
 * sign them in, bootstrap canonical tenants, and return everything needed
 * for PostgREST attack tests.
 */
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL!;
const ANON = process.env.SUPABASE_ANON_KEY!;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export interface TenantUser {
  id: string;
  email: string;
  password: string;
  jwt: string;
  client_entity_id: string;
  ledger_book_id: string;
  practice_id: string;
  membership_id: string;
}

async function adminCreateUser(email: string, password: string): Promise<string> {
  const res = await fetch(`${URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SVC,
      Authorization: `Bearer ${SVC}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body: any = await res.json();
  if (!res.ok && !String(res.status).startsWith("2")) {
    throw new Error(`admin create user failed: ${res.status} ${JSON.stringify(body)}`);
  }
  if (body.id) return body.id;
  if (Array.isArray(body)) return body[0].id;
  throw new Error(`unexpected admin response: ${JSON.stringify(body)}`);
}

async function signIn(email: string, password: string): Promise<{ jwt: string; userId: string }> {
  const res = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: ANON,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  const body: any = await res.json();
  if (!res.ok) throw new Error(`sign in failed: ${res.status} ${JSON.stringify(body)}`);
  return { jwt: body.access_token, userId: body.user.id };
}

export async function ensureTenant(userId: string): Promise<{
  client_entity_id: string;
  ledger_book_id: string;
  practice_id: string;
  membership_id: string;
}> {
  const admin = createClient(URL, SVC, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc("ensure_default_tenant_for_user_v1", {
    p_user_id: userId,
  });
  if (error) throw new Error(`ensure tenant failed: ${error.message}`);
  const row: any = data;
  return {
    client_entity_id: row.client_entity_id,
    ledger_book_id: row.internal_ledger_book_id,
    practice_id: row.practice_id,
    membership_id: row.practice_membership_id,
  };
}

export async function setupTwoTenants(): Promise<{ a: TenantUser; b: TenantUser }> {
  const stamp = Date.now().toString(36);
  const aEmail = `tenant-a-${stamp}@test.local`;
  const bEmail = `tenant-b-${stamp}@test.local`;
  const aPw = "Passw0rd!local";
  const bPw = "Passw0rd!local";

  const aId = await adminCreateUser(aEmail, aPw);
  const bId = await adminCreateUser(bEmail, bPw);
  const aAuth = await signIn(aEmail, aPw);
  const bAuth = await signIn(bEmail, bPw);
  const aTenant = await ensureTenant(aId);
  const bTenant = await ensureTenant(bId);

  return {
    a: {
      id: aId, email: aEmail, password: aPw, jwt: aAuth.jwt,
      ...aTenant,
    },
    b: {
      id: bId, email: bEmail, password: bPw, jwt: bAuth.jwt,
      ...bTenant,
    },
  };
}