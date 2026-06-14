import { Env } from './config.js';

const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface XeroTrackingCategory {
  TrackingCategoryID: string;
  Name: string;
  Options: Array<{ TrackingOptionID: string; Name: string; Status: string }>;
}

// In-memory caches per Worker invocation
let cachedAccessToken: string | null = null;
let tokenExpiry = 0;
let cachedTrackingCategories: XeroTrackingCategory[] | null = null;

const KV_REFRESH_TOKEN_KEY = 'xero_refresh_token';

async function getRefreshToken(env: Env): Promise<string> {
  if (env.XERO_TOKENS) {
    const kv = await env.XERO_TOKENS.get(KV_REFRESH_TOKEN_KEY);
    if (kv) return kv;
  }
  if (env.XERO_REFRESH_TOKEN) return env.XERO_REFRESH_TOKEN;
  throw new Error('No Xero refresh token found — seed KV or set XERO_REFRESH_TOKEN');
}

async function saveRefreshToken(token: string, env: Env): Promise<void> {
  if (env.XERO_TOKENS) {
    await env.XERO_TOKENS.put(KV_REFRESH_TOKEN_KEY, token);
  }
}

async function getAccessToken(env: Env): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiry - 60_000) {
    return cachedAccessToken;
  }

  const refreshToken = await getRefreshToken(env);

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.XERO_CLIENT_ID,
    client_secret: env.XERO_CLIENT_SECRET,
  });

  const res = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Xero token refresh failed ${res.status}: ${text}`);
  }

  const token = await res.json() as TokenResponse;
  cachedAccessToken = token.access_token;
  tokenExpiry = Date.now() + token.expires_in * 1000;

  await saveRefreshToken(token.refresh_token, env);

  return cachedAccessToken;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function xeroFetch(
  path: string,
  env: Env,
  options: RequestInit = {},
  attempt = 1
): Promise<unknown> {
  const token = await getAccessToken(env);
  const res = await fetch(`${XERO_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Xero-Tenant-Id': env.XERO_TENANT_ID,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers ?? {}),
    },
  });

  if (res.status === 429 && attempt <= 5) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? 60);
    console.log(`  Xero rate limit hit, waiting ${retryAfter}s before retry ${attempt}/5...`);
    await sleep(retryAfter * 1000);
    return xeroFetch(path, env, options, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Xero API error ${res.status} for ${path}: ${text}`);
  }
  return res.json();
}

async function getTrackingCategories(env: Env): Promise<XeroTrackingCategory[]> {
  if (cachedTrackingCategories) return cachedTrackingCategories;
  const data = await xeroFetch('/TrackingCategories', env) as {
    TrackingCategories: XeroTrackingCategory[];
  };
  cachedTrackingCategories = data.TrackingCategories;
  return cachedTrackingCategories;
}

export async function ensureTrackingOption(
  categoryName: string,
  optionName: string,
  env: Env
): Promise<void> {
  const categories = await getTrackingCategories(env);
  const category = categories.find(c => c.Name === categoryName);
  if (!category) {
    throw new Error(`Xero tracking category "${categoryName}" not found`);
  }

  const exists = category.Options.some(
    o => o.Name.toLowerCase() === optionName.toLowerCase() && o.Status === 'ACTIVE'
  );
  if (exists) return;

  console.log(`Creating tracking option "${optionName}" in category "${categoryName}"`);
  await xeroFetch(`/TrackingCategories/${category.TrackingCategoryID}/Options`, env, {
    method: 'PUT',
    body: JSON.stringify({ Name: optionName }),
  });

  cachedTrackingCategories = null;
}

export interface XeroTracking {
  Name: string;
  Option: string;
}

export interface XeroLineItem {
  Description: string;
  Quantity: number;
  UnitAmount: number;
  AccountCode: string;
  TaxType: 'NONE';
  Tracking?: XeroTracking[];
}

export async function transactionExists(transactionCode: string, env: Env): Promise<boolean> {
  const data = await xeroFetch(
    `/BankTransactions?where=Reference%3D%3D%22${transactionCode}%22%26%26Status%3D%3D%22AUTHORISED%22`,
    env
  ) as { BankTransactions: unknown[] };
  return data.BankTransactions.length > 0;
}

export interface CreateTransactionParams {
  reference: string;   // SumUp transaction_code — used as Xero reference for dedup
  paidAt: string;
  netAmount: number;   // in currency units (pounds)
  currency: string;
  lineItems: XeroLineItem[];
}

export async function createBankTransaction(
  params: CreateTransactionParams,
  env: Env
): Promise<void> {
  const payload = {
    BankTransactions: [
      {
        Type: 'RECEIVE',
        Contact: { Name: 'SumUp' },
        Date: params.paidAt.split('T')[0],
        Reference: params.reference,
        CurrencyCode: params.currency,
        IsReconciled: false,
        BankAccount: { AccountID: env.XERO_BANK_ACCOUNT_ID },
        LineItems: params.lineItems,
      },
    ],
  };

  await xeroFetch('/BankTransactions', env, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
