# sumup-xero-reconcile

GitHub Actions workflow that polls SumUp daily for completed payouts and creates matching bank transactions in Xero. Each settlement deposit gets a `RECEIVE` transaction with one line item per card payment plus a fees line, so Xero can auto-reconcile it against the bank statement.

---

## How it works

1. The workflow runs daily at 7am UTC (and can be triggered manually).
2. It fetches SumUp payouts executed in the past 8 days.
3. For each payout not already in Xero, it fetches the individual card transactions for that payout date.
4. It creates a Xero `RECEIVE` bank transaction:
   - One line item per card payment → account **224**, gross amount
   - One negative aggregate fee line → account **404**
   - Net amount = payout settlement amount (matches the bank deposit exactly)
5. Tracking is applied to each payment line: `Fund Type = Unrestricted`, `Group Activities = <product name entered in SumUp>`. Tracking options are created in Xero automatically if they don't exist yet.
6. A success or error email is sent via Resend.

Deduplication is by payout ID stored as the Xero `Reference` field — re-runs are safe.

---

## GitHub Secrets

Set these in **Settings → Secrets and variables → Actions → Secrets**:

| Secret | Description |
|--------|-------------|
| `SUMUP_API_KEY` | SumUp personal access token ([developer.sumup.com](https://developer.sumup.com)) |
| `XERO_CLIENT_ID` | Xero app client ID |
| `XERO_CLIENT_SECRET` | Xero app client secret |
| `XERO_TENANT_ID` | Xero organisation ID |
| `XERO_REFRESH_TOKEN` | Initial Xero refresh token (rotated automatically after each run) |
| `XERO_BANK_ACCOUNT_ID` | UUID of the Xero bank account SumUp settles into |
| `NOTIFY_EMAIL` | Address to receive success/error notifications |
| `RESEND_API_KEY` | Resend API key (optional — omit to skip emails) |

## Repository variables

Set these in **Settings → Secrets and variables → Actions → Variables** (not secrets):

| Variable | Default | Description |
|----------|---------|-------------|
| `XERO_TRACKING_FUND_TYPE` | `Fund Type` | Xero tracking category name — must match exactly |
| `XERO_TRACKING_GROUP_ACTIVITIES` | `Group Activities` | Xero tracking category name — must match exactly |
| `LOOKBACK_DAYS` | `8` | Days back to scan for payouts on each run |

---

## Xero refresh token rotation

Xero rotates the refresh token on every use. The workflow has `permissions: secrets: write`, so after each successful token refresh it writes the new token back to the `XERO_REFRESH_TOKEN` secret automatically. No manual intervention needed.

If you're using a Xero Custom Connection (which uses `client_credentials` instead of OAuth), no refresh token is needed at all and this is a no-op.

---

## Local development

```bash
cp .env.example .env
# fill in .env

npm install
npm run sync:dry    # fetches payouts and logs — no Xero writes
npm run sync        # live run
```

---

## Manual trigger

Go to **Actions → SumUp → Xero daily sync → Run workflow**. You can enable the `dry_run` toggle to preview without writing to Xero, and optionally override `lookback_days`.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| `Xero refresh token failed 400` | Refresh token has expired or been invalidated — re-run the Xero OAuth flow and update the `XERO_REFRESH_TOKEN` secret |
| `Xero tracking category "X" not found` | Category name in repository variables doesn't exactly match Xero — check capitalisation |
| `SumUp API error 401` | `SUMUP_API_KEY` is invalid or expired — regenerate in the SumUp developer portal |
| Net amount mismatch warning in logs | Some transactions on the payout date may have a different status or the SumUp API is paginating — check SumUp portal for the payout details |
| Transaction created twice | Shouldn't happen — deduplication checks for an `AUTHORISED` Xero transaction with `Reference == payout.id` before creating |
