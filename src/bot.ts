import { Bot, Context, webhookCallback } from 'grammy';
import { T, QUIZ, QUIZ_LABEL } from './texts';
import { kbStartQuiz, kbSubscribe, kbQuizOptions, kbToLanding } from './keyboards';
import { getUser, sb, upsertUser } from './supabase';

export type Env = {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  CHANNEL_ID: string;
  CHANNEL_INVITE: string;
  LANDING_URL: string;
  PDF_URL: string;
  PITCH_PHOTO_URL?: string;       // опционально: фото «Мичико с книгой» перед продажным текстом
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
};

type Ctx = Context & { env: Env };

export function createBot(env: Env) {
  const bot = new Bot<Ctx>(env.BOT_TOKEN);

  // Пробрасываем env во все обработчики.
  bot.use(async (ctx, next) => { (ctx as Ctx).env = env; await next(); });

  const client = sb(env);

  // ========== /start ==========
  bot.command('start', async (ctx) => {
    const from = ctx.from!;
    const source = (ctx.match || '').trim() || null;
    await upsertUser(client, {
      tg_id: from.id,
      username: from.username ?? null,
      first_name: from.first_name ?? null,
      source,
      state: 'welcome',
    });
    await ctx.reply(T.welcome(from.first_name), { parse_mode: 'HTML' });
    await ctx.reply(T.ask_subscribe(env.CHANNEL_INVITE), {
      reply_markup: kbSubscribe(env.CHANNEL_INVITE),
      link_preview_options: { is_disabled: true },
    });
  });

  // ========== Проверка подписки ==========
  bot.callbackQuery('check_sub', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from!.id;
    const ok = await isSubscribed(env, userId);
    if (!ok) {
      await ctx.reply(T.not_subscribed, {
        reply_markup: kbSubscribe(env.CHANNEL_INVITE),
      });
      return;
    }
    await upsertUser(client, {
      tg_id: userId,
      subscribed_at: new Date().toISOString(),
      pdf_sent_at: new Date().toISOString(),
      state: 'pdf_sent',
    });
    // Первое сообщение — выдача подарка.
    await ctx.reply(T.pdf_sent(env.PDF_URL), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: false },
    });
    // Небольшая пауза + «печатает…» — чтобы приглашение в квиз выглядело как отдельная мысль.
    await ctx.replyWithChatAction('typing').catch(() => {});
    await new Promise((r) => setTimeout(r, 2200));
    await ctx.reply(T.quiz_invite, {
      parse_mode: 'HTML',
      reply_markup: kbStartQuiz(),
    });
  });

  // ========== Квиз ==========
  bot.callbackQuery('quiz_start', async (ctx) => {
    await ctx.answerCallbackQuery();
    await upsertUser(client, { tg_id: ctx.from!.id, state: 'quiz_age' });
    await ctx.reply(T.quiz_age, { reply_markup: kbQuizOptions(QUIZ.age, 'age') });
  });

  bot.callbackQuery('quiz_skip', async (ctx) => {
    await ctx.answerCallbackQuery();
    await upsertUser(client, { tg_id: ctx.from!.id, state: 'quiz_skipped' });
    await ctx.reply(T.quiz_cancelled);
  });

  bot.callbackQuery(/^age:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.callbackQuery.data.split(':')[1];
    await upsertUser(client, { tg_id: ctx.from!.id, quiz_age: id, state: 'quiz_problem' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.reply(T.quiz_problem, { reply_markup: kbQuizOptions(QUIZ.problem, 'problem') });
  });

  bot.callbackQuery(/^problem:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.callbackQuery.data.split(':')[1];
    await upsertUser(client, { tg_id: ctx.from!.id, quiz_problem: id, state: 'quiz_tried' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.reply(T.quiz_tried, { reply_markup: kbQuizOptions(QUIZ.tried, 'tried') });
  });

  bot.callbackQuery(/^tried:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.callbackQuery.data.split(':')[1];
    const userId = ctx.from!.id;
    await upsertUser(client, {
      tg_id: userId, quiz_tried: id,
      quiz_completed_at: new Date().toISOString(),
      state: 'quiz_done',
    });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const user = await getUser(client, userId);
    const problemLabel = user?.quiz_problem ? (QUIZ_LABEL[user.quiz_problem] || 'проблема с кожей') : 'проблема с кожей';
    const landingUrl = withUtm(env.LANDING_URL, {
      utm_source: 'bot', utm_medium: 'quiz',
      utm_content: `${user?.quiz_age || ''}_${user?.quiz_problem || ''}`,
    });
    // Опциональное фото перед продающим текстом — выглядит живее.
    if (env.PITCH_PHOTO_URL) {
      try {
        await ctx.replyWithPhoto(env.PITCH_PHOTO_URL, {
          caption: T.quiz_photo_caption,
          parse_mode: 'HTML',
        });
        await ctx.replyWithChatAction('typing').catch(() => {});
        await new Promise((r) => setTimeout(r, 1600));
      } catch (e) {
        console.error('replyWithPhoto failed', e);
      }
    }
    await ctx.reply(T.quiz_result(problemLabel, landingUrl), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: kbToLanding(landingUrl),
    });
  });

  // ========== Фолбэк ==========
  bot.on('message', async (ctx) => { await ctx.reply(T.unknown); });

  bot.catch((err) => { console.error('bot error', err); });

  return bot;
}

async function isSubscribed(env: Env, userId: number): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember?chat_id=${env.CHANNEL_ID}&user_id=${userId}`;
    const r = await fetch(url);
    const j: any = await r.json();
    if (!j.ok) { console.error('getChatMember failed', j); return false; }
    const status = j.result?.status;
    return status === 'creator' || status === 'administrator' || status === 'member' || status === 'restricted';
  } catch (e) {
    console.error('isSubscribed error', e);
    return false;
  }
}

function withUtm(base: string, params: Record<string, string>): string {
  try {
    const u = new URL(base);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    return u.toString();
  } catch { return base; }
}

export function createWebhookHandler(env: Env) {
  const bot = createBot(env);
  return webhookCallback(bot, 'cloudflare-mod', { secretToken: env.WEBHOOK_SECRET });
}
