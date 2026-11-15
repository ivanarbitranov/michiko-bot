import { createWebhookHandler, type Env } from './bot';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check — удобно в браузере проверить что воркер жив.
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('michiko-bot is alive 🌸', { status: 200 });
    }

    // Одноразовый endpoint для регистрации webhook в Telegram.
    // Защищён параметром ?token=<WEBHOOK_SECRET>.
    if (request.method === 'GET' && url.pathname === '/setup') {
      const token = url.searchParams.get('token');
      if (token !== env.WEBHOOK_SECRET) return new Response('nope', { status: 403 });
      const webhookUrl = `${url.origin}/webhook`;
      const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ['message', 'callback_query'],
          drop_pending_updates: true,
        }),
      });
      const j = await r.json();
      return new Response(JSON.stringify(j, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // Telegram webhook.
    if (request.method === 'POST' && url.pathname === '/webhook') {
      const handler = createWebhookHandler(env);
      return handler(request);
    }

    return new Response('not found', { status: 404 });
  },
};
