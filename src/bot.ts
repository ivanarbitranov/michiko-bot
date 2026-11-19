import { Bot, Context, webhookCallback } from 'grammy';
import { T, QUIZ, QUIZ_LABEL } from './texts';
import { kbStartQuiz, kbSubscribe, kbQuizOptions, kbToLanding } from './keyboards';
import { getUser, sb, upsertUser } from './supabase';

export type Env = {
  BOT_TOKEN: string;
  BOT_ID: string;                 // slug бота в таблице `bots` (для статистики в дашборде)
  WEBHOOK_SECRET: string;
  CHANNEL_ID: string;
  CHANNEL_INVITE: string;
  LANDING_URL: string;
  PDF_URL: string;
  PITCH_PHOTO_URL?: string;       // опционально: фото «Мичико с книгой» перед продажным текстом
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  ADMIN_TG_ID?: string;           // твой личный tg user_id, куда пересылать заявки
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

    // Живая консультация (приход из модалки ленда через /start contact)
    if (source && source.startsWith('contact')) {
      await upsertUser(client, {
        tg_id: from.id,
        bot_id: env.BOT_ID,
        username: from.username ?? null,
        first_name: from.first_name ?? null,
        source,
        state: 'contact_waiting',
      });
      await ctx.reply(T.contact_welcome(from.first_name), { parse_mode: 'HTML' });
      await notifyAdmin(env, buildNewContactNotice(from, source));
      return;
    }

    // Старая funnel-воронка (подписка на канал + PDF + квиз)
    await upsertUser(client, {
      tg_id: from.id,
      bot_id: env.BOT_ID,
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

  // ========== Пересылка сообщений ==========
  bot.on('message', async (ctx) => {
    const from = ctx.from!;
    const msg = ctx.message;

    // 1) Админ отвечает reply'ем на пересланное сообщение — переправляем юзеру
    if (env.ADMIN_TG_ID && String(from.id) === String(env.ADMIN_TG_ID)) {
      const replyTo = msg.reply_to_message;
      const marker = replyTo?.text?.match(/\[USER:(\d+)\]/) || replyTo?.caption?.match(/\[USER:(\d+)\]/);
      if (marker) {
        const userId = Number(marker[1]);
        try {
          if (msg.text) {
            await ctx.api.sendMessage(userId, msg.text);
          } else if (msg.photo && msg.photo.length) {
            await ctx.api.sendPhoto(userId, msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption });
          } else if (msg.voice) {
            await ctx.api.sendVoice(userId, msg.voice.file_id, { caption: msg.caption });
          } else if (msg.document) {
            await ctx.api.sendDocument(userId, msg.document.file_id, { caption: msg.caption });
          } else if (msg.video) {
            await ctx.api.sendVideo(userId, msg.video.file_id, { caption: msg.caption });
          } else {
            await ctx.reply('⚠ Этот тип сообщения не поддерживается для пересылки.');
            return;
          }
          await ctx.react('👌').catch(() => {});
        } catch (e: any) {
          await ctx.reply(`❌ Не удалось отправить: ${e?.description || e?.message || 'ошибка'}`);
        }
        return;
      }
      // Если это сообщение от админа без reply — молча игнорируем (или подскажем)
      if (!msg.text?.startsWith('/')) {
        await ctx.reply('Чтобы ответить клиенту — сделай reply на пересланное сообщение с меткой [USER:...]');
      }
      return;
    }

    // 2) Юзер в контакт-режиме — пересылаем админу
    const user = await getUser(client, from.id);
    if (user?.state?.startsWith('contact')) {
      await forwardUserMessageToAdmin(env, ctx);
      await upsertUser(client, { tg_id: from.id, state: 'contact_active' });
      if (user.state === 'contact_waiting') {
        await ctx.reply(T.contact_received);
      }
      return;
    }

    // 3) Остальное — стандартный fallback
    await ctx.reply(T.unknown);
  });

  bot.catch((err) => { console.error('bot error', err); });

  return bot;
}

// ===== Admin notifications =====

function buildNewContactNotice(
  from: { id: number; first_name?: string; last_name?: string; username?: string },
  source: string,
): string {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || '(без имени)';
  const uname = from.username ? `@${from.username}` : '—';
  return `🆕 Новая заявка в @babushka_michiko_bot

👤 <b>${escapeHtml(name)}</b>
🔗 ${escapeHtml(uname)}
🌱 Источник: <code>${escapeHtml(source)}</code>

[USER:${from.id}]

↩️ Чтобы ответить — сделай <b>reply</b> на это сообщение, текст уйдёт клиенту от имени Мичико.`;
}

async function forwardUserMessageToAdmin(env: Env, ctx: Context) {
  if (!env.ADMIN_TG_ID) return;
  const from = ctx.from!;
  const msg = ctx.message!;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || '(без имени)';
  const uname = from.username ? `@${from.username}` : '—';
  const header = `💬 Сообщение от <b>${escapeHtml(name)}</b> (${escapeHtml(uname)})
[USER:${from.id}]
`;

  try {
    if (msg.text) {
      await ctx.api.sendMessage(env.ADMIN_TG_ID, header + '\n' + escapeHtml(msg.text), { parse_mode: 'HTML' });
    } else if (msg.photo && msg.photo.length) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      await ctx.api.sendPhoto(env.ADMIN_TG_ID, fileId, { caption: header + '\n' + escapeHtml(msg.caption || ''), parse_mode: 'HTML' });
    } else if (msg.voice) {
      await ctx.api.sendVoice(env.ADMIN_TG_ID, msg.voice.file_id, { caption: header, parse_mode: 'HTML' });
    } else if (msg.document) {
      await ctx.api.sendDocument(env.ADMIN_TG_ID, msg.document.file_id, { caption: header + '\n' + escapeHtml(msg.caption || ''), parse_mode: 'HTML' });
    } else if (msg.video) {
      await ctx.api.sendVideo(env.ADMIN_TG_ID, msg.video.file_id, { caption: header + '\n' + escapeHtml(msg.caption || ''), parse_mode: 'HTML' });
    } else if (msg.sticker) {
      await ctx.api.sendMessage(env.ADMIN_TG_ID, header + '\n(стикер)', { parse_mode: 'HTML' });
      await ctx.api.sendSticker(env.ADMIN_TG_ID, msg.sticker.file_id);
    } else {
      await ctx.api.sendMessage(env.ADMIN_TG_ID, header + '\n(неподдерживаемый тип сообщения)', { parse_mode: 'HTML' });
    }
  } catch (e) {
    console.error('forwardUserMessageToAdmin error', e);
  }
}

async function notifyAdmin(env: Env, text: string) {
  if (!env.ADMIN_TG_ID) return;
  try {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.ADMIN_TG_ID, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('notifyAdmin error', e);
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
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
