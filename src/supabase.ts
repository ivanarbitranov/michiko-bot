import { createClient, SupabaseClient } from '@supabase/supabase-js';

export type BotUser = {
  tg_id: number;
  username: string | null;
  first_name: string | null;
  source: string | null;      // utm_source при /start, например 'bio' / 'bridge'
  subscribed_at: string | null;
  pdf_sent_at: string | null;
  quiz_age: string | null;
  quiz_problem: string | null;
  quiz_tried: string | null;
  quiz_completed_at: string | null;
  state: string | null;       // текущий шаг FSM
  landing_click_at: string | null;
  created_at: string;
  updated_at: string;
};

export function sb(env: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string }): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetch.bind(globalThis) },
  });
}

export async function getUser(client: SupabaseClient, tg_id: number): Promise<BotUser | null> {
  const { data } = await client.from('bot_users').select('*').eq('tg_id', tg_id).maybeSingle();
  return (data as BotUser) ?? null;
}

export async function upsertUser(client: SupabaseClient, u: Partial<BotUser> & { tg_id: number }) {
  const { error } = await client.from('bot_users').upsert({ ...u, updated_at: new Date().toISOString() }, { onConflict: 'tg_id' });
  if (error) console.error('upsertUser error', error);
}
