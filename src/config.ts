// Minimal KV interface — matches Cloudflare KVNamespace without requiring workers-types
export interface KVStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface Env {
  SUMUP_API_KEY: string;        // Personal access token for SumUp API
  SUMUP_WEBHOOK_SECRET: string; // Secret used to verify incoming webhook signatures
  XERO_CLIENT_ID: string;
  XERO_CLIENT_SECRET: string;
  XERO_TENANT_ID: string;
  XERO_REFRESH_TOKEN: string;   // Fallback for local CLI use; Worker uses KV
  XERO_BANK_ACCOUNT_ID: string;
  XERO_ACCOUNT_CARD_SALES: string;  // e.g. 200 — card payment income
  XERO_ACCOUNT_FEES: string;        // e.g. 404 — SumUp transaction fees
  XERO_TRACKING_FUND_TYPE: string;        // Xero tracking category name, e.g. "Fund Type"
  XERO_TRACKING_GROUP_ACTIVITIES: string; // e.g. "Group Activities"
  XERO_TOKENS?: KVStore;        // Cloudflare KV — stores rotating Xero refresh token
  RESEND_API_KEY?: string;
  NOTIFY_EMAIL?: string;
  NOTIFY_FROM?: string;
}
