-- Таблица подписчиков бота @babushka_michiko_bot.
-- Данные доступны только serverless-функции (anon ключ) — RLS закрыта от пользователей.
-- Запусти в Supabase → SQL Editor → RUN.

create table if not exists bot_users (
  tg_id bigint primary key,
  username text,
  first_name text,
  source text,                      -- utm_source / параметр /start=xxx
  subscribed_at timestamptz,
  pdf_sent_at timestamptz,
  quiz_age text,
  quiz_problem text,
  quiz_tried text,
  quiz_completed_at timestamptz,
  state text,                       -- последний шаг сценария
  landing_click_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_bot_users_state on bot_users(state);
create index if not exists idx_bot_users_created on bot_users(created_at desc);

-- RLS: оставляем включённой, политик нет = никто (anon/auth) не читает напрямую.
-- Бот работает через service_role в будущем или через собственный backend —
-- пока бот пишет через anon key, разрешим этой роли вставку/обновление без чтения:
alter table bot_users enable row level security;
drop policy if exists bot_users_upsert on bot_users;
create policy bot_users_upsert on bot_users for all to anon using (true) with check (true);
