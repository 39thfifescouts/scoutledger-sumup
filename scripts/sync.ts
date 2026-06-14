/**
 * SumUp → Xero daily sync
 *
 * Polls SumUp for completed payouts over the past LOOKBACK_DAYS days and
 * creates matching Xero RECEIVE bank transactions so they can be reconciled
 * against the SumUp settlement deposits in the bank feed.
 *
 * One Xero transaction per payout:
 *   - one line item per card payment (gross amount → account 224)
 *   - one aggregate negative fee line (→ account 404)
 *   - net = payout.amount, matching the bank deposit exactly
 *
 * Tracking: Fund Type = Unrestricted (always), Group Activities = product_name (auto-created).
 *
 * Usage:
 *   npm run sync            # live run
 *   npm run sync:dry        # dry run — fetches and logs, no Xero writes
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Load .env file when running locally
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const DRY_RUN = process.argv.includes("--dry-run");
const SUMUP_API_KEY = requireEnv("SUMUP_API_KEY");
const XERO_CLIENT_ID = requireEnv("XERO_CLIENT_ID");
const XERO_CLIENT_SECRET = requireEnv("XERO_CLIENT_SECRET");
const XERO_TENANT_ID = requireEnv("XERO_TENANT_ID");
const XERO_BANK_ACCOUNT_ID = requireEnv("XERO_BANK_ACCOUNT_ID");
const XERO_TRACKING_FUND_TYPE = process.env["XERO_TRACKING_FUND_TYPE"] ?? "Fund Type";
const XERO_TRACKING_GROUP_ACTIVITIES = process.env["XERO_TRACKING_GROUP_ACTIVITIES"] ?? "Group Activities";
const LOOKBACK_DAYS = Number(process.env["LOOKBACK_DAYS"] ?? "8");

const XERO_ACCOUNT_CARD_SALES = "224";
const XERO_ACCOUNT_FEES = "404";

const SUMUP_API_BASE = "https://api.sumup.com/v0.1";
const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";

// ---------------------------------------------------------------------------
// SumUp types
// ---------------------------------------------------------------------------

interface SumUpPayout {
  id: string;
  date: string;       // YYYY-MM-DD
  amount: number;     // net settlement amount in currency units
  fee_amount: number; // total fees deducted
  currency: string;
  status: string;     // "EXECUTED" | "PENDING" | "FAILED"
}

interface SumUpTransaction {
  id: string;
  transaction_code: string;
  amount: number;      // gross amount paid by customer
  fee_amount: number;  // SumUp fee for this transaction
  currency: string;
  timestamp: string;   // ISO8601
  status: string;      // "SUCCESSFUL" | "FAILED" | "CANCELLED" | "REFUNDED"
  product_name?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// SumUp API
// ---------------------------------------------------------------------------

async function sumupFetch(urlPath: string): Promise<unknown> {
  const res = await fetch(`${SUMUP_API_BASE}${urlPath}`, {
    headers: { Authorization: `Bearer ${SUMUP_API_KEY}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`SumUp API error ${res.status} for ${urlPath}: ${await res.text()}`);
  return res.json();
}

async function listPayouts(since: string): Promise<SumUpPayout[]> {
  // SumUp returns payouts newest-first; fetch enough to cover LOOKBACK_DAYS
  const data = await sumupFetch("/me/financials/payouts?limit=20&order=desc") as {
    items?: SumUpPayout[];
  };
  return (data.items ?? []).filter(
    p => p.status === "EXECUTED" && p.date >= since
  );
}

async function listTransactionsForPayout(payoutDate: string): Promise<SumUpTransaction[]> {
  const data = await sumupFetch(
    `/me/financials/transactions?payout_date=${payoutDate}&limit=100`
  ) as { items?: SumUpTransaction[] };
  return (data.items ?? []).filter(t => t.status === "SUCCESSFUL");
}

// ---------------------------------------------------------------------------
// Xero auth (same pattern as scoutledger-expenses)
// ---------------------------------------------------------------------------

let xeroToken: string | null = null;
let xeroTokenExpiresAt = 0;

async function getXeroToken(): Promise<string> {
  if (xeroToken && Date.now() < xeroTokenExpiresAt - 30_000) return xeroToken;

  const credentials = Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString("base64");

  // Try client_credentials first (Xero Custom Connection — no refresh token needed)
  try {
    const res = await fetch("https://identity.xero.com/connect/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${credentials}` },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "accounting.transactions" }).toString(),
    });
    if (res.ok) {
      const data = await res.json() as { access_token: string; expires_in: number };
      xeroToken = data.access_token;
      xeroTokenExpiresAt = Date.now() + data.expires_in * 1000;
      return xeroToken;
    }
  } catch {
    // fall through to refresh token
  }

  // Fall back to refresh token flow
  const refreshToken = process.env["XERO_REFRESH_TOKEN"];
  if (!refreshToken) throw new Error("Xero client_credentials failed and no XERO_REFRESH_TOKEN set.");

  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${credentials}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
  });
  if (!res.ok) throw new Error(`Xero refresh token failed ${res.status}: ${await res.text()}`);
  const data = await res.json() as { access_token: string; expires_in: number; refresh_token?: string };

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await persistRefreshToken(data.refresh_token);
  }

  xeroToken = data.access_token;
  xeroTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return xeroToken;
}

async function persistRefreshToken(token: string): Promise<void> {
  if (process.env["GITHUB_ACTIONS"]) {
    await updateGitHubSecret("XERO_REFRESH_TOKEN", token);
    return;
  }
  // Locally: rewrite .env
  if (fs.existsSync(envPath)) {
    let contents = fs.readFileSync(envPath, "utf8");
    if (contents.match(/^XERO_REFRESH_TOKEN=.*/m)) {
      contents = contents.replace(/^XERO_REFRESH_TOKEN=.*/m, `XERO_REFRESH_TOKEN=${token}`);
    } else {
      contents = contents.trimEnd() + `\nXERO_REFRESH_TOKEN=${token}\n`;
    }
    fs.writeFileSync(envPath, contents);
    console.log("Rotated Xero refresh token written to .env.");
  }
}

async function updateGitHubSecret(secretName: string, value: string): Promise<void> {
  const ghToken = process.env["GITHUB_TOKEN"];
  const repo = process.env["GITHUB_REPOSITORY"];
  if (!ghToken || !repo) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY must be set to persist refresh token in CI.");

  const keyRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/public-key`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
  });
  if (!keyRes.ok) throw new Error(`GitHub public key fetch failed ${keyRes.status}: ${await keyRes.text()}`);
  const { key_id, key } = await keyRes.json() as { key_id: string; key: string };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sodium = require("libsodium-wrappers") as typeof import("libsodium-wrappers");
  await sodium.ready;
  const keyBytes = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  const valueBytes = sodium.from_string(value);
  const encrypted = sodium.crypto_box_seal(valueBytes, keyBytes);
  const encryptedBase64 = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);

  const putRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/${secretName}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ encrypted_value: encryptedBase64, key_id }),
  });
  if (!putRes.ok) throw new Error(`GitHub secret update failed ${putRes.status}: ${await putRes.text()}`);
  console.log(`Rotated Xero refresh token persisted to GitHub secret ${secretName}.`);
}

// ---------------------------------------------------------------------------
// Xero API helpers
// ---------------------------------------------------------------------------

function xeroHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Xero-Tenant-Id": XERO_TENANT_ID,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function xeroGet(urlPath: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`${XERO_API_BASE}${urlPath}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const token = await getXeroToken();
  const res = await fetch(url.toString(), { headers: xeroHeaders(token) });
  if (!res.ok) throw new Error(`Xero GET ${url} failed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function xeroPost(urlPath: string, body: unknown): Promise<unknown> {
  const token = await getXeroToken();
  const res = await fetch(`${XERO_API_BASE}${urlPath}`, {
    method: "POST",
    headers: xeroHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Xero POST ${urlPath} failed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function transactionExists(payoutId: string): Promise<boolean> {
  const data = await xeroGet("/BankTransactions", {
    where: `Reference=="${payoutId}"&&Status=="AUTHORISED"`,
  }) as { BankTransactions: unknown[] };
  return data.BankTransactions.length > 0;
}

// ---------------------------------------------------------------------------
// Tracking categories
// ---------------------------------------------------------------------------

interface XeroTrackingCategory {
  TrackingCategoryID: string;
  Name: string;
  Options: Array<{ TrackingOptionID: string; Name: string; Status: string }>;
}

let cachedCategories: XeroTrackingCategory[] | null = null;

async function getTrackingCategories(): Promise<XeroTrackingCategory[]> {
  if (cachedCategories) return cachedCategories;
  const data = await xeroGet("/TrackingCategories") as { TrackingCategories: XeroTrackingCategory[] };
  cachedCategories = data.TrackingCategories;
  return cachedCategories;
}

async function ensureTrackingOption(categoryName: string, optionName: string): Promise<void> {
  const categories = await getTrackingCategories();
  const category = categories.find(c => c.Name === categoryName);
  if (!category) throw new Error(`Xero tracking category "${categoryName}" not found`);

  const exists = category.Options.some(
    o => o.Name.toLowerCase() === optionName.toLowerCase() && o.Status === "ACTIVE"
  );
  if (exists) return;

  console.log(`  Creating tracking option "${optionName}" in "${categoryName}"`);
  await xeroGet(`/TrackingCategories/${category.TrackingCategoryID}/Options`); // warm cache
  await xeroPost(`/TrackingCategories/${category.TrackingCategoryID}/Options`, { Name: optionName });
  cachedCategories = null; // invalidate so next call picks up the new option
}

// ---------------------------------------------------------------------------
// Line item builder
// ---------------------------------------------------------------------------

interface XeroLineItem {
  Description: string;
  Quantity: number;
  UnitAmount: number;
  AccountCode: string;
  TaxType: "NONE";
  Tracking?: Array<{ Name: string; Option: string }>;
}

function buildLineItems(transactions: SumUpTransaction[]): XeroLineItem[] {
  const items: XeroLineItem[] = [];
  let totalFees = 0;

  for (const tx of transactions) {
    const productName = tx.product_name?.trim() || tx.description?.trim() || "";
    const tracking: Array<{ Name: string; Option: string }> = [
      { Name: XERO_TRACKING_FUND_TYPE, Option: "Unrestricted" },
    ];
    if (productName) {
      tracking.push({ Name: XERO_TRACKING_GROUP_ACTIVITIES, Option: productName });
    }

    items.push({
      Description: productName || tx.transaction_code,
      Quantity: 1,
      UnitAmount: tx.amount,
      AccountCode: XERO_ACCOUNT_CARD_SALES,
      TaxType: "NONE",
      Tracking: tracking,
    });

    totalFees += tx.fee_amount ?? 0;
  }

  if (totalFees > 0) {
    items.push({
      Description: "SumUp transaction fees",
      Quantity: 1,
      UnitAmount: -totalFees,
      AccountCode: XERO_ACCOUNT_FEES,
      TaxType: "NONE",
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Xero bank transaction
// ---------------------------------------------------------------------------

async function createBankTransaction(
  payout: SumUpPayout,
  lineItems: XeroLineItem[]
): Promise<void> {
  await xeroPost("/BankTransactions", {
    BankTransactions: [{
      Type: "RECEIVE",
      Contact: { Name: "SumUp" },
      Date: payout.date,
      Reference: payout.id,
      CurrencyCode: payout.currency,
      IsReconciled: false,
      BankAccount: { AccountID: XERO_BANK_ACCOUNT_ID },
      LineItems: lineItems,
    }],
  });
}

// ---------------------------------------------------------------------------
// Email notification
// ---------------------------------------------------------------------------

async function sendEmail(subject: string, body: string): Promise<void> {
  const apiKey = process.env["RESEND_API_KEY"];
  const to = process.env["NOTIFY_EMAIL"];
  if (!apiKey || !to) return;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "onboarding@resend.dev", to, subject, text: body }),
  });
  if (!res.ok) console.error(`Resend failed ${res.status}: ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (DRY_RUN) console.log("[DRY RUN] No data will be written to Xero.\n");

  const since = new Date();
  since.setDate(since.getDate() - LOOKBACK_DAYS);
  const sinceStr = since.toISOString().split("T")[0]!;

  console.log(`=== SumUp → Xero sync (lookback: ${LOOKBACK_DAYS} days, since ${sinceStr}) ===\n`);

  const payouts = await listPayouts(sinceStr);
  console.log(`Found ${payouts.length} executed payout(s) since ${sinceStr}.`);

  const created: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const payout of payouts) {
    try {
      if (await transactionExists(payout.id)) {
        console.log(`  skip ${payout.id} (${payout.date}) — already in Xero`);
        skipped.push(payout.id);
        continue;
      }

      const transactions = await listTransactionsForPayout(payout.date);
      console.log(`  payout ${payout.id} | ${payout.currency} ${payout.amount.toFixed(2)} | ${payout.date} | ${transactions.length} transaction(s)`);

      const lineItems = buildLineItems(transactions);

      const grossTotal = transactions.reduce((s, t) => s + t.amount, 0);
      const feeTotal = transactions.reduce((s, t) => s + (t.fee_amount ?? 0), 0);
      const net = grossTotal - feeTotal;
      if (Math.abs(net - payout.amount) > 0.02) {
        console.warn(`  WARNING: line items net ${net.toFixed(2)} but payout.amount is ${payout.amount.toFixed(2)}`);
      }

      if (DRY_RUN) {
        console.log("  [dry-run] would create:", JSON.stringify(lineItems, null, 2));
        created.push(payout.id);
        continue;
      }

      // Ensure all Group Activities tracking options exist in Xero
      const productNames = new Set(
        transactions.map(t => t.product_name?.trim() || t.description?.trim() || "").filter(Boolean)
      );
      await ensureTrackingOption(XERO_TRACKING_FUND_TYPE, "Unrestricted");
      for (const name of productNames) {
        await ensureTrackingOption(XERO_TRACKING_GROUP_ACTIVITIES, name);
      }

      await createBankTransaction(payout, lineItems);
      console.log(`  ✓ created Xero transaction for ${payout.id}`);
      created.push(payout.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR processing payout ${payout.id}: ${msg}`);
      errors.push(`${payout.id}: ${msg}`);
    }
  }

  const timestamp = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
  console.log(`\nDone at ${timestamp}. Created: ${created.length}, skipped: ${skipped.length}, errors: ${errors.length}`);

  if (errors.length > 0) {
    await sendEmail(
      `🚨 SumUp reconciliation error (${errors.length} payout${errors.length > 1 ? "s" : ""})`,
      `Errors at ${timestamp}:\n\n${errors.map(e => `• ${e}`).join("\n")}\n\nCheck GitHub Actions logs.`
    );
  } else if (created.length > 0 && !DRY_RUN) {
    await sendEmail(
      `✅ SumUp payout${created.length > 1 ? "s" : ""} reconciled (${created.length})`,
      `Successfully created Xero transaction${created.length > 1 ? "s" : ""} at ${timestamp}:\n\n${created.map(id => `• ${id}`).join("\n")}\n\nCheck Xero to reconcile against your bank statement.`
    );
  }

  if (errors.length > 0) process.exit(1);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
