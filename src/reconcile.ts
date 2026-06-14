import { Env } from './config.js';
import { SumUpTransaction } from './sumup.js';
import {
  XeroLineItem, XeroTracking,
  createBankTransaction, ensureTrackingOption, transactionExists,
} from './xero.js';

// Categorise a SumUp payment into a Xero account code and Group Activities option
// by inspecting the product name / description entered at point of sale.
//
// Add more patterns here as the group uses SumUp for different income streams.
// Any unrecognised description falls through to card sales (XERO_ACCOUNT_CARD_SALES).
function categorise(
  tx: SumUpTransaction,
  env: Env
): { accountCode: string; groupActivity: string | null } {
  const text = (tx.product_name ?? tx.description ?? '').trim();

  // "Camps & Events" or "Camp" in the description → 201 / Camps & Events
  if (/camps?\s*(?:&|and)\s*events?|camp\b/i.test(text)) {
    return { accountCode: env.XERO_ACCOUNT_FEES, groupActivity: 'Camps & Events' };
  }

  // Default — card sales income
  return { accountCode: env.XERO_ACCOUNT_CARD_SALES, groupActivity: null };
}

function trackingFor(
  accountCode: string,
  groupActivity: string | null,
  env: Env
): XeroTracking[] {
  const tracking: XeroTracking[] = [
    { Name: env.XERO_TRACKING_FUND_TYPE, Option: 'Unrestricted' },
  ];
  if (groupActivity) {
    tracking.push({ Name: env.XERO_TRACKING_GROUP_ACTIVITIES, Option: groupActivity });
  }
  return tracking;
}

function buildLineItems(tx: SumUpTransaction, env: Env): XeroLineItem[] {
  const { accountCode, groupActivity } = categorise(tx, env);
  const label = tx.product_name ?? tx.description ?? tx.transaction_code;

  const items: XeroLineItem[] = [
    {
      Description: label,
      Quantity: 1,
      UnitAmount: tx.amount,
      AccountCode: accountCode,
      TaxType: 'NONE',
      Tracking: trackingFor(accountCode, groupActivity, env),
    },
  ];

  // SumUp deducts its fee from the settlement; record it as a separate line item
  // so the gross receipt and fee are both visible in Xero.
  if (tx.fee_amount && tx.fee_amount > 0) {
    items.push({
      Description: `SumUp fee (${tx.transaction_code})`,
      Quantity: 1,
      UnitAmount: -tx.fee_amount, // negative: reduces the RECEIVE amount
      AccountCode: env.XERO_ACCOUNT_FEES,
      TaxType: 'NONE',
    });
  }

  return items;
}

export async function processTransaction(
  tx: SumUpTransaction,
  env: Env
): Promise<'created' | 'skipped'> {
  if (tx.status !== 'SUCCESSFUL') {
    console.log(`  skip: transaction ${tx.transaction_code} has status ${tx.status}`);
    return 'skipped';
  }

  if (await transactionExists(tx.transaction_code, env)) {
    console.log(`  skip: Xero transaction already exists for ${tx.transaction_code}`);
    return 'skipped';
  }

  const lineItems = buildLineItems(tx, env);
  const netAmount = tx.amount - (tx.fee_amount ?? 0);

  console.log(
    `  transaction ${tx.transaction_code} | ${tx.currency} ${tx.amount.toFixed(2)} ` +
    `(fee: ${(tx.fee_amount ?? 0).toFixed(2)}) | ${tx.timestamp.split('T')[0]} ` +
    `| ${lineItems.length} line items`
  );

  // Ensure all tracking options exist before posting
  const groupActivities = new Set(
    lineItems.flatMap(li =>
      (li.Tracking ?? [])
        .filter(t => t.Name === env.XERO_TRACKING_GROUP_ACTIVITIES)
        .map(t => t.Option)
    )
  );
  for (const option of groupActivities) {
    await ensureTrackingOption(env.XERO_TRACKING_GROUP_ACTIVITIES, option, env);
  }
  await ensureTrackingOption(env.XERO_TRACKING_FUND_TYPE, 'Unrestricted', env);

  await createBankTransaction({
    reference: tx.transaction_code,
    paidAt: tx.timestamp,
    netAmount,
    currency: tx.currency,
    lineItems,
  }, env);

  console.log(`  ✓ created Xero transaction for ${tx.transaction_code}`);
  return 'created';
}
