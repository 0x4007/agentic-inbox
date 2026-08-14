// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	/** Production wrangler configuration pins this to `b2`; local fixtures override it at runtime. */
	EMAIL_STORAGE_MODE: "b2";
	/** Scoped Backblaze B2 S3 application-key ID. Never expose this value. */
	EMAIL_B2_KEY_ID?: string;
	/** Scoped Backblaze B2 S3 application key. Never expose this value. */
	EMAIL_B2_APPLICATION_KEY?: string;
	GMAIL_CLIENT_ID?: string;
	GMAIL_CLIENT_SECRET?: string;
	GMAIL_TOKEN_ENCRYPTION_KEY?: string;
	UOS_AUTH_TOKEN?: string;
}
