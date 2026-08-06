import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";

/**
 * Returns the current Supabase user ID on the client, or null when
 * Supabase is not configured or there is no active session.
 */
export function useUserId(): string | null {
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return;

    const supabase = createClient(url, key, { auth: { persistSession: false } });
    supabase.auth.getUser().then(({ data, error }) => {
      if (!error && data.user) {
        setUserId(data.user.id);
      }
    });
  }, []);

  return userId;
}