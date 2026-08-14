// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	GMAIL_CLIENT_ID?: string;
	GMAIL_CLIENT_SECRET?: string;
	GMAIL_TOKEN_ENCRYPTION_KEY?: string;
	UOS_AUTH_TOKEN?: string;
}
