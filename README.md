# michiko-bot

Telegram-бот `@babushka_michiko_bot` на Cloudflare Workers + grammY + Supabase.

Воронка:
1. `/start` → приветствие от Мичико
2. Просьба подписаться на закрытый канал → проверка подписки (`getChatMember`)
3. Выдача подарка — PDF «3 утренних ритуала для свежего лица за 5 минут»
4. Квиз из 3 вопросов (возраст / проблема / что пробовала)
5. Персональный ответ + ссылка на лендинг-трипваер с UTM

Хостинг — Cloudflare Workers (бесплатно, 100k запросов/день). Не нужен сервер.

## Деплой

### 1. Миграция в Supabase

Супабейс → SQL Editor → RUN содержимое `supabase/migrations/001_bot_users.sql`.

### 2. Залить код на Cloudflare Workers

Вариант A — через Cloudflare Dashboard (проще, одноклик):

1. https://dash.cloudflare.com → Compute → Workers & Pages → Create → **Import a repository** → выбери `ivanarbitranov/michiko-bot`.
2. Build settings: `npm install`, deploy command `npx wrangler deploy`.
3. **Variables and Secrets** — добавь секреты (ТОЛЬКО через type: Secret, не Text!):
   - `BOT_TOKEN` — токен от @BotFather
   - `WEBHOOK_SECRET` — любая длинная случайная строка, например `openssl rand -hex 32`
4. Публичные переменные уже в `wrangler.toml`; обнови `CHANNEL_INVITE` на реальную ссылку на вступление в канал.
5. Нажми Deploy.

Вариант B — через CLI (на своём компе):

```bash
npm install
npx wrangler login
npx wrangler secret put BOT_TOKEN       # вставить токен
npx wrangler secret put WEBHOOK_SECRET  # вставить длинный рандомный секрет
npm run deploy
```

### 3. Зарегистрировать webhook

После деплоя Worker будет доступен по адресу `https://michiko-bot.<твой-subdomain>.workers.dev`.

Зарегистрируй webhook (один раз):
```
https://michiko-bot.<твой-subdomain>.workers.dev/setup?token=<WEBHOOK_SECRET>
```

Откроешь в браузере — увидишь `{ "ok": true, "result": true, ... }`. Всё.

### 4. Добавить бота в канал

@babushka_michiko_bot → добавить как администратора в закрытый канал Мичико. Права: минимум «читать участников» (нужно для `getChatMember`).

### 5. Тест

Напиши `/start` боту. Должно сработать всё по сценарию.

## Структура

- `src/index.ts` — точка входа Worker (routing `/`, `/setup`, `/webhook`).
- `src/bot.ts` — создание grammY-бота, обработчики команд и колбэков.
- `src/texts.ts` — все тексты и варианты квиза (правь без паники).
- `src/keyboards.ts` — inline-клавиатуры.
- `src/supabase.ts` — работа с БД подписчиков.
- `supabase/migrations/` — SQL миграции.
- `wrangler.toml` — конфиг Cloudflare Workers.
