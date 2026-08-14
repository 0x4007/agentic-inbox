// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Loader } from "@cloudflare/kumo";
import {
	ArrowRightIcon,
	CheckCircleIcon,
	EnvelopeSimpleIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { DEFAULT_THREAD_AUTOMATION, toThreadAutomationUpdate } from "~/components/ThreadAutomationPanel";
import { queryKeys } from "~/queries/keys";
import api, { ApiError } from "~/services/api";
import type { ThreadAutomationUpdate } from "~/types";
import "~/styles/gmail-activation.css";

const LOGICAL_MAILBOX_ID = "pavlovcik.com";

export function activationReturnPath(gmailThreadId: string): string {
	return `/activate/gmail/${encodeURIComponent(gmailThreadId)}`;
}

export function dashboardThreadPath(threadId: string): string {
	return `/mailbox/${LOGICAL_MAILBOX_ID}/emails/inbox?thread=${encodeURIComponent(threadId)}`;
}

function getErrorMessage(error: unknown, fallback: string): string {
	if (error instanceof ApiError) return error.message;
	if (error instanceof Error) return error.message;
	return fallback;
}

function ActivationCard({ children }: { children: React.ReactNode }) {
	return (
		<main
			className="mx-auto flex min-h-[100dvh] w-full max-w-xl items-center px-4 py-8 sm:px-6"
			data-gmail-activation
		>
			<section
				className="w-full rounded-2xl bg-kumo-base p-6 shadow-xl shadow-black/15 sm:p-8"
				data-activation-card
			>
				<div className="flex h-11 w-11 items-center justify-center rounded-xl bg-kumo-fill text-kumo-default">
					<EnvelopeSimpleIcon size={24} weight="duotone" />
				</div>
				{children}
			</section>
		</main>
	);
}

export default function GmailActivationRoute() {
	const { gmailThreadId } = useParams<{ gmailThreadId: string }>();
	const navigate = useNavigate();
	const activationStartedForRef = useRef<string | null>(null);

	useEffect(() => {
		const previousPage = document.body.dataset.page;
		document.body.dataset.page = "gmail-activation";
		return () => {
			if (previousPage) document.body.dataset.page = previousPage;
			else delete document.body.dataset.page;
		};
	}, []);

	const gmailStatusQuery = useQuery({
		queryKey: queryKeys.gmail.status,
		queryFn: () => api.getGmailStatus(),
		enabled: Boolean(gmailThreadId),
		staleTime: 0,
	});

	const activationMutation = useMutation({
		mutationFn: async (id: string) => {
			const imported = await api.importGmailThread(id);
			let update: ThreadAutomationUpdate = {
				...DEFAULT_THREAD_AUTOMATION,
				enabled: true,
			};

			try {
				const existing = await api.getThreadAutomation(imported.threadId);
				update = { ...toThreadAutomationUpdate(existing), enabled: true };
			} catch (error) {
				if (!(error instanceof ApiError) || error.status !== 404) throw error;
			}

			await api.updateThreadAutomation(imported.threadId, update);
			return imported.threadId;
		},
		onSuccess: (threadId) => {
			navigate(dashboardThreadPath(threadId), { replace: true });
		},
	});

	useEffect(() => {
		if (!gmailThreadId || !gmailStatusQuery.data?.connected) return;
		if (activationStartedForRef.current === gmailThreadId) return;
		activationStartedForRef.current = gmailThreadId;
		activationMutation.mutate(gmailThreadId);
	}, [activationMutation, gmailStatusQuery.data?.connected, gmailThreadId]);

	if (!gmailThreadId) {
		return (
			<ActivationCard>
				<h1 className="mt-6 text-2xl font-semibold tracking-tight text-kumo-default">
					No Gmail thread found
				</h1>
				<p className="mt-2 text-sm leading-relaxed text-kumo-subtle">
					Open this page from a Gmail conversation with a stable thread ID.
				</p>
			</ActivationCard>
		);
	}

	if (gmailStatusQuery.isPending) {
		return (
			<ActivationCard>
				<div className="mt-6 flex items-center gap-3 text-sm text-kumo-subtle" aria-live="polite">
					<Loader size="sm" />
					Checking your Gmail connection…
				</div>
			</ActivationCard>
		);
	}

	if (gmailStatusQuery.isError) {
		return (
			<ActivationCard>
				<h1 className="mt-6 text-2xl font-semibold tracking-tight text-kumo-default">
					Gmail connection unavailable
				</h1>
				<div className="mt-3 flex gap-2 rounded-xl bg-kumo-destructive/10 p-3 text-sm leading-relaxed text-kumo-destructive" role="alert">
					<WarningIcon size={18} weight="fill" className="mt-0.5 shrink-0" />
					{getErrorMessage(gmailStatusQuery.error, "Please try again.")}
				</div>
				<Button
					variant="secondary"
					className="mt-5"
					onClick={() => void gmailStatusQuery.refetch()}
				>
					Try again
				</Button>
			</ActivationCard>
		);
	}

	if (!gmailStatusQuery.data?.connected) {
		return (
			<ActivationCard>
				<h1 className="mt-6 text-2xl font-semibold tracking-tight text-kumo-default">
					Connect Gmail to watch this thread
				</h1>
				<p className="mt-2 text-sm leading-relaxed text-kumo-subtle">
					Gmail access is read-only. After you approve it, this page will import the current thread and turn on watching.
				</p>
				<Button
					variant="primary"
					className="mt-6"
					icon={<ArrowRightIcon size={16} />}
					onClick={() => {
						window.location.assign(
							api.getGmailOAuthStartUrl(activationReturnPath(gmailThreadId)),
						);
					}}
				>
					Connect Gmail
				</Button>
			</ActivationCard>
		);
	}

	if (activationMutation.isError) {
		return (
			<ActivationCard>
				<h1 className="mt-6 text-2xl font-semibold tracking-tight text-kumo-default">
					This thread could not be activated
				</h1>
				<div className="mt-3 flex gap-2 rounded-xl bg-kumo-destructive/10 p-3 text-sm leading-relaxed text-kumo-destructive" role="alert">
					<WarningIcon size={18} weight="fill" className="mt-0.5 shrink-0" />
					{getErrorMessage(activationMutation.error, "The Gmail thread was not changed.")}
				</div>
				<Button
					variant="secondary"
					className="mt-5"
					onClick={() => {
						activationStartedForRef.current = null;
						activationMutation.reset();
						activationMutation.mutate(gmailThreadId);
					}}
				>
					Try again
				</Button>
			</ActivationCard>
		);
	}

	return (
		<ActivationCard>
			<h1 className="mt-6 text-2xl font-semibold tracking-tight text-kumo-default">
				Importing this Gmail thread
			</h1>
			<p className="mt-2 text-sm leading-relaxed text-kumo-subtle">
				We are importing the complete thread and turning on draft mode for future replies.
			</p>
			<div className="mt-6 flex items-center gap-3 text-sm text-kumo-subtle" aria-live="polite">
				<Loader size="sm" />
				Preparing your dashboard…
			</div>
			<p className="mt-6 flex items-center gap-1.5 text-xs text-kumo-success">
				<CheckCircleIcon size={14} weight="fill" />
				Connected as {gmailStatusQuery.data.accountEmail || "your Gmail account"}
			</p>
		</ActivationCard>
	);
}
