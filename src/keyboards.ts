import { InlineKeyboard } from 'grammy';
import { QUIZ } from './texts';

export const kbSubscribe = (invite: string) =>
  new InlineKeyboard()
    .url('🌸 Перейти в канал', invite).row()
    .text('Я подписалась, проверить', 'check_sub');

export const kbStartQuiz = () =>
  new InlineKeyboard()
    .text('Да, задавай 🌸', 'quiz_start').row()
    .text('Не сейчас', 'quiz_skip');

export const kbQuizOptions = (opts: Array<{ id: string; label: string }>, prefix: string) => {
  const kb = new InlineKeyboard();
  opts.forEach((o) => kb.text(o.label, `${prefix}:${o.id}`).row());
  return kb;
};

export const kbToLanding = (landingUrl: string) =>
  new InlineKeyboard().url('💎 Открыть систему — 990 ₽', landingUrl);
