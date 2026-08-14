// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Loader } from "@cloudflare/kumo";
import {
	CheckCircleIcon,
	ClockIcon,
	EnvelopeSimpleIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "~/queries/keys";
import api, { ApiError } from "~/services/api";
import type {
	ThreadAutomation,
	ThreadAutomationUpdate,
} from "~/types";

const AUTOSAVE_DELAY_MS = 650;

export const DEFAULT_THREAD_AUTOMATION: ThreadAutomationUpdate = {
	enabled: false,
	mode: "draft",
	goalPrompt: "",
	privateNotes: "",
};

export function toThreadAutomationUpdate(
	automation: ThreadAutomation,
): ThreadAutomationUpdate {
	return {
		enabled: automation.enabled,
		mode: automation.mode,
		goalPrompt: automation.goalPrompt,
		privateNotes: automation.privateNotes,
	};
}

export function getAgentActionLabel(
	action: ThreadAutomation["lastAction"],
): string {
	switch (action) {
		case "drafted":
			return "Draft saved";
		case "sent":
			return "Reply sent";
		case "failed":
			return "Reply failed";
		default:
			return "No reply yet";
	}
}

function getErrorMessage(error: unknown, fallback: string): string {
	if (error instanceof ApiError) return error.message;
	if (error instanceof Error) return error.message;
	return fallback;
}

function formatTimestamp(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "Unknown time";
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
}

type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

interface QueuedSave {
	threadId: string;
	update: ThreadAutomationUpdate;
}

function SaveState({ status, error }: { status: SaveStatus; error: string | null }) {
	if (status === "error") {
		return (
			<p className="flex items-center gap-1.5 text-xs text-kumo-destructive" role="alert">
				<WarningIcon size={14} weight="fill" />
				{error || "Could not save changes."}
			</p>
		);
	}

	if (status === "pending" || status === "saving") {
		return (
			<p className="flex items-center gap-1.5 text-xs text-kumo-subtle" aria-live="polite">
				<Loader size="sm" />
				Saving changes…
			</p>
		);
	}

	if (status === "saved") {
		return (
			<p className="flex items-center gap-1.5 text-xs text-kumo-success" aria-live="polite">
				<CheckCircleIcon size={14} weight="fill" />
				Saved
			</p>
		);
	}

	return <span className="text-xs text-kumo-subtle">Changes save automatically.</span>;
}

export default function ThreadAutomationPanel({ threadId }: { threadId: string }) {
	const queryClient = useQueryClient();
	const [form, setForm] = useState<ThreadAutomationUpdate | null>(null);
	const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
	const [saveError, setSaveError] = useState<string | null>(null);
	const activeThreadIdRef = useRef(threadId);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const queuedSaveRef = useRef<QueuedSave | null>(null);
	const saveInFlightRef = useRef(false);
	const flushRef = useRef<() => Promise<void>>(async () => {});
	const formRef = useRef<ThreadAutomationUpdate | null>(null);

	const automationQuery = useQuery({
		queryKey: queryKeys.threadAutomation.detail(threadId),
		queryFn: () => api.getThreadAutomation(threadId),
		refetchInterval: 30_000,
	});

	const replaceForm = useCallback((next: ThreadAutomationUpdate | null) => {
		formRef.current = next;
		setForm(next);
	}, []);

	const flush = useCallback(async () => {
		if (saveInFlightRef.current) return;

		const queued = queuedSaveRef.current;
		if (!queued) return;

		saveInFlightRef.current = true;
		queuedSaveRef.current = null;
		setSaveStatus("saving");

		try {
			const saved = await api.updateThreadAutomation(queued.threadId, queued.update);
			queryClient.setQueryData(
				queryKeys.threadAutomation.detail(queued.threadId),
				saved,
			);

			if (
				activeThreadIdRef.current === queued.threadId &&
				queuedSaveRef.current === null
			) {
				replaceForm(toThreadAutomationUpdate(saved));
				setSaveStatus("saved");
				setSaveError(null);
			}
		} catch (error) {
			// A later edit is a complete replacement, so it may still be saved.
			// Keep the failed snapshot only when no later edit is waiting.
			if (queuedSaveRef.current === null) {
				queuedSaveRef.current = queued;
				if (activeThreadIdRef.current === queued.threadId) {
					setSaveStatus("error");
					setSaveError(getErrorMessage(error, "Could not save changes."));
				}
			}
		} finally {
			saveInFlightRef.current = false;
			// Save a newer edit after the current request completes. Do not retry a
			// failed snapshot until the person edits again or leaves a field.
			if (queuedSaveRef.current && queuedSaveRef.current !== queued) {
				void flushRef.current();
			}
		}
	}, [queryClient, replaceForm]);

	useEffect(() => {
		flushRef.current = flush;
	}, [flush]);

	useEffect(() => {
		activeThreadIdRef.current = threadId;
		if (saveTimerRef.current) {
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
		queuedSaveRef.current = null;
		replaceForm(null);
		setSaveStatus("idle");
		setSaveError(null);
	}, [replaceForm, threadId]);

	useEffect(() => {
		if (!automationQuery.data) return;
		if (queuedSaveRef.current || saveInFlightRef.current) return;
		replaceForm(toThreadAutomationUpdate(automationQuery.data));
	}, [automationQuery.data, replaceForm]);

	useEffect(() => {
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		};
	}, []);

	const scheduleSave = useCallback((next: ThreadAutomationUpdate, immediate = false) => {
		replaceForm(next);
		queuedSaveRef.current = { threadId: activeThreadIdRef.current, update: next };
		setSaveError(null);
		setSaveStatus("pending");

		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		if (immediate) {
			saveTimerRef.current = null;
			void flushRef.current();
			return;
		}

		saveTimerRef.current = setTimeout(() => {
			saveTimerRef.current = null;
			void flushRef.current();
		}, AUTOSAVE_DELAY_MS);
	}, [replaceForm]);

	const updateField = <K extends keyof ThreadAutomationUpdate>(
		field: K,
		value: ThreadAutomationUpdate[K],
		immediate = false,
	) => {
		const current = formRef.current ?? DEFAULT_THREAD_AUTOMATION;
		scheduleSave({ ...current, [field]: value }, immediate);
	};

	const retrySave = () => {
		if (queuedSaveRef.current) {
			void flushRef.current();
		}
	};

	if (automationQuery.isError) {
		return (
			<aside
				className="order-first shrink-0 border-b border-kumo-line bg-kumo-recessed px-4 py-4 xl:order-last xl:w-[22rem] xl:border-b-0 xl:border-l xl:px-5"
				aria-label="Thread automation"
			>
				<div className="flex items-start gap-2 text-sm text-kumo-destructive" role="alert">
					<WarningIcon size={18} weight="fill" className="mt-0.5 shrink-0" />
					<div>
						<p className="font-medium">Thread controls are unavailable.</p>
						<p className="mt-1 text-xs text-kumo-subtle">
							{getErrorMessage(automationQuery.error, "Please try again.")}
						</p>
						<Button
							variant="secondary"
							size="sm"
							className="mt-3"
							onClick={() => void automationQuery.refetch()}
						>
							Try again
						</Button>
					</div>
				</div>
			</aside>
		);
	}

	if (automationQuery.isPending || form === null) {
		return (
			<aside
				className="order-first flex shrink-0 items-center gap-2 border-b border-kumo-line bg-kumo-recessed px-4 py-3 text-sm text-kumo-subtle xl:order-last xl:w-[22rem] xl:border-b-0 xl:border-l xl:px-5"
				aria-label="Thread automation"
			>
				<Loader size="sm" />
				Loading thread automation…
			</aside>
		);
	}

	const automation = automationQuery.data;

	return (
		<aside
			className="order-first flex max-h-[45dvh] shrink-0 flex-col overflow-y-auto border-b border-kumo-line bg-kumo-recessed xl:order-last xl:h-full xl:max-h-none xl:w-[22rem] xl:border-b-0 xl:border-l"
			data-thread-automation
			aria-label="Thread automation"
		>
			<header className="border-b border-kumo-line px-4 py-3 xl:px-5">
				<div className="flex items-center justify-between gap-3">
					<div>
						<p className="text-sm font-semibold text-kumo-default">Thread automation</p>
						<p className="mt-0.5 text-xs text-kumo-subtle">Changes save automatically.</p>
					</div>
					<label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-kumo-default">
						<input
							type="checkbox"
							checked={form.enabled}
							onChange={(event) => updateField("enabled", event.target.checked, true)}
							aria-label="Watch this thread"
						/>
						Watch
					</label>
				</div>
				<div className="mt-3">
					<SaveState status={saveStatus} error={saveError} />
					{saveStatus === "error" && (
						<button
							type="button"
							onClick={retrySave}
							className="mt-1 text-xs font-medium text-kumo-brand underline underline-offset-2"
						>
							Retry save
						</button>
					)}
				</div>
			</header>

			<div className="flex flex-col gap-5 px-4 py-4 xl:px-5">
				<section>
					<div className="flex items-center justify-between gap-3">
						<label className="text-xs font-medium text-kumo-strong" htmlFor="automation-mode-draft">
							Reply mode
						</label>
						<span className="text-xs text-kumo-subtle">When watched</span>
					</div>
					<div className="mt-2 grid grid-cols-2 rounded-lg bg-kumo-fill p-1" role="radiogroup" aria-label="Reply mode">
						<button
							id="automation-mode-draft"
							type="button"
							role="radio"
							aria-checked={form.mode === "draft"}
							onClick={() => updateField("mode", "draft", true)}
							className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
								form.mode === "draft"
									? "bg-kumo-base text-kumo-default shadow-sm"
									: "text-kumo-subtle hover:text-kumo-default"
							}`}
						>
							Draft
						</button>
						<button
							type="button"
							role="radio"
							aria-checked={form.mode === "auto"}
							onClick={() => updateField("mode", "auto", true)}
							className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
								form.mode === "auto"
									? "bg-kumo-base text-kumo-default shadow-sm"
									: "text-kumo-subtle hover:text-kumo-default"
							}`}
						>
							Auto-send
						</button>
					</div>
					{form.mode === "auto" && (
						<p className="mt-2 flex gap-1.5 text-xs leading-relaxed text-kumo-warning" role="status">
							<WarningIcon size={15} weight="fill" className="mt-0.5 shrink-0" />
							Auto-send sends every successfully generated reply for this thread without review.
						</p>
					)}
				</section>

				<section>
					<label htmlFor="automation-goal" className="text-xs font-medium text-kumo-strong">
						Goal prompt
					</label>
					<p className="mt-1 text-xs leading-relaxed text-kumo-subtle">
						Tell the agent what a useful reply should achieve.
					</p>
					<textarea
						id="automation-goal"
						value={form.goalPrompt}
						onChange={(event) => updateField("goalPrompt", event.target.value)}
						onBlur={() => void flushRef.current()}
						rows={4}
						placeholder="For example: confirm the delivery window and ask for the final quote."
						className="mt-2 w-full resize-y rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm leading-relaxed text-kumo-default outline-none transition-shadow placeholder:text-kumo-subtle focus:ring-2 focus:ring-kumo-brand/30"
					/>
				</section>

				<section>
					<label htmlFor="automation-notes" className="text-xs font-medium text-kumo-strong">
						Private notes
					</label>
					<p className="mt-1 text-xs leading-relaxed text-kumo-subtle">
						Visible only in this dashboard. They are never sent in the reply.
					</p>
					<textarea
						id="automation-notes"
						value={form.privateNotes}
						onChange={(event) => updateField("privateNotes", event.target.value)}
						onBlur={() => void flushRef.current()}
						rows={4}
						placeholder="Context, constraints, or names to keep in mind."
						className="mt-2 w-full resize-y rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm leading-relaxed text-kumo-default outline-none transition-shadow placeholder:text-kumo-subtle focus:ring-2 focus:ring-kumo-brand/30"
					/>
				</section>

				<section className="border-t border-kumo-line pt-4">
					<p className="text-xs font-medium text-kumo-strong">Thread status</p>
					<dl className="mt-3 grid gap-3 text-xs">
						<div className="flex items-start justify-between gap-4">
							<dt className="flex items-center gap-1.5 text-kumo-subtle">
								<EnvelopeSimpleIcon size={14} /> Gmail import
							</dt>
							<dd className="max-w-[13rem] break-all text-right text-kumo-default">
								{automation.gmailThreadId || "Inbox thread"}
							</dd>
						</div>
						<div className="flex items-start justify-between gap-4">
							<dt className="text-kumo-subtle">Last action</dt>
							<dd className={automation.lastAction === "failed" ? "text-kumo-destructive" : "text-kumo-default"}>
								{getAgentActionLabel(automation.lastAction)}
							</dd>
						</div>
						<div className="flex items-start justify-between gap-4">
							<dt className="flex items-center gap-1.5 text-kumo-subtle">
								<ClockIcon size={14} /> Updated
							</dt>
							<dd className="text-right text-kumo-default">{formatTimestamp(automation.updatedAt)}</dd>
						</div>
					</dl>
					{automation.lastError && (
						<p className="mt-3 flex gap-1.5 rounded-lg bg-kumo-destructive/10 px-3 py-2 text-xs leading-relaxed text-kumo-destructive" role="alert">
							<WarningIcon size={15} weight="fill" className="mt-0.5 shrink-0" />
							{automation.lastError}
						</p>
					)}
				</section>
			</div>
		</aside>
	);
}
