import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";

export interface PostingAuthorizationRefreshInput {
  actorUserId: string;
  operationIds: string[];
  refreshRequestId: string;
}

export interface PostingAuthorizationRefreshResult {
  kind: "REFRESHED" | "BLOCKED";
  reasonCode?: string;
  operationId?: string;
  authorizations?: Array<{
    operationId: string;
    authorizationId: string;
    expiresAt: string;
    refreshed: boolean;
  }>;
}

export class PostingAuthorizationRefreshService {
  constructor(private readonly db: Pick<SupabaseClient, "rpc">) {}

  async refresh(input: PostingAuthorizationRefreshInput): Promise<PostingAuthorizationRefreshResult> {
    const { data, error } = await this.db.rpc("refresh_posting_human_authorizations_v1", {
      p_operation_ids: input.operationIds,
      p_actor_user_id: input.actorUserId,
      p_refresh_request_id: input.refreshRequestId,
      p_ttl_seconds: 3600,
    });
    if (error) throw new Error(`Posting authorization refresh failed: ${error.message}`);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Posting authorization refresh returned no payload");
    }
    return data as unknown as PostingAuthorizationRefreshResult;
  }
}

export function createPostingAuthorizationRefreshService(): PostingAuthorizationRefreshService {
  const db = getSupabase();
  if (!db) throw new Error("Posting authorization refresh requires a configured database");
  return new PostingAuthorizationRefreshService(db);
}
