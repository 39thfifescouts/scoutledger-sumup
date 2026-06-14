import { Env } from './config.js';
import { SumUpWebhookPayload, verifyWebhookSignature } from './sumup.js';
import { processTransaction } from './reconcile.js';

async function sendEmail(subject: string, body: string, env: Env): Promise<void> {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) return;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.NOTIFY_FROM ?? 'onboarding@resend.dev',
        to: env.NOTIFY_EMAIL,
        subject,
        text: body,
      }),
    });
    if (!res.ok) {
      console.error(`Resend email failed ${res.status}: ${await res.text()}`);
    } else {
      console.log(`Email sent: ${subject}`);
    }
  } catch (err) {
    console.error('Failed to send email via Resend:', err);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const body = await request.text();
    const signature = request.headers.get('X-Payload-Signature');

    const valid = await verifyWebhookSignature(body, signature, env.SUMUP_WEBHOOK_SECRET);
    if (!valid) {
      console.error('Invalid webhook signature');
      return new Response('Unauthorized', { status: 401 });
    }

    let payload: SumUpWebhookPayload;
    try {
      payload = JSON.parse(body) as SumUpWebhookPayload;
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    if (payload.event_type !== 'PAYMENT') {
      // Acknowledge but ignore non-payment events
      return new Response('OK', { status: 200 });
    }

    const tx = payload.payload;
    const timestamp = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });

    try {
      console.log(`Processing SumUp payment: ${tx.transaction_code}`);
      const result = await processTransaction(tx, env);

      if (result === 'created') {
        await sendEmail(
          `✅ SumUp payment reconciled (${tx.transaction_code})`,
          `Successfully created Xero transaction at ${timestamp}:\n\n` +
          `• ${tx.transaction_code}: ${tx.currency} ${tx.amount.toFixed(2)} — ${tx.product_name ?? tx.description ?? 'Card payment'}\n\n` +
          `Check Xero to confirm and reconcile against your bank statement.`,
          env
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to process transaction ${tx.transaction_code}: ${msg}`);
      await sendEmail(
        `🚨 SumUp reconciliation error (${tx.transaction_code})`,
        `Error occurred at ${timestamp}:\n\n• ${tx.transaction_code}: ${msg}\n\nCheck Cloudflare logs: npx wrangler tail`,
        env
      );
    }

    // Always return 200 — SumUp retries on non-2xx
    return new Response('OK', { status: 200 });
  },
};
