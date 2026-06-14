import { Env } from './config.js';

const SUMUP_API_BASE = 'https://api.sumup.com/v0.1';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SumUpTransaction {
  id: string;
  transaction_code: string;
  amount: number;          // gross amount paid by customer, in currency units (not pence)
  fee_amount: number;      // SumUp transaction fee, in currency units
  currency: string;
  timestamp: string;       // ISO8601
  status: 'SUCCESSFUL' | 'FAILED' | 'CANCELLED' | 'PENDING' | 'REFUNDED';
  payment_type: string;    // e.g. "MASTERCARD", "VISA", "AMEX"
  product_name?: string;   // description entered at point of sale
  description?: string;
}

// Webhook payload sent by SumUp for payment events.
// SumUp wraps the transaction in a `payload` envelope.
export interface SumUpWebhookPayload {
  id: string;          // webhook event ID
  event_type: 'PAYMENT';
  merchant_code: string;
  created_at: string;
  payload: SumUpTransaction;
}

// ── Webhook verification ─────────────────────────────────────────────────────

// SumUp signs webhooks with HMAC-SHA256. The signature is sent in the
// `X-Payload-Signature` header as a hex-encoded digest.
export async function verifyWebhookSignature(
  body: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Signature may arrive as "sha256=<hex>" or bare "<hex>"
  const received = signature.replace(/^sha256=/, '');
  return expected === received;
}

// ── API client ───────────────────────────────────────────────────────────────

async function sumupFetch(path: string, env: Env): Promise<unknown> {
  const res = await fetch(`${SUMUP_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${env.SUMUP_API_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SumUp API error ${res.status} for ${path}: ${text}`);
  }
  return res.json();
}

export async function getTransaction(transactionId: string, env: Env): Promise<SumUpTransaction> {
  const data = await sumupFetch(`/me/transactions/${transactionId}`, env) as SumUpTransaction;
  return data;
}
