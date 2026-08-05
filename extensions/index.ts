import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const HERDR_TAB_ID = process.env.HERDR_TAB_ID;
const HERDR_ENV_ENABLED = process.env.HERDR_ENV === "1";
let fallbackTabLabel = defaultTabLabel();

const AUTONAME_MAX_WORDS = 10;
const AUTONAME_MAX_CHARS = 90;
const AUTONAME_SAMPLE_SIZE = 4;
const AUTONAME_LOADING_LABEL = "Loading...";
const HERDR_NEW_SESSION_LABEL = "New session";

function formatSessionName(value: string): string {
	return value.trim().replace(/\s+/g, " ").slice(0, AUTONAME_MAX_CHARS);
}

function defaultTabLabel(): string {
	const project = process.cwd().split("/").filter(Boolean).at(-1) || "pi";
	const now = new Date();
	const isoDate = now.toISOString().slice(0, 10);
	const time = now.toTimeString().slice(0, 8).replace(/:/g, "-");
	return `${project} ${isoDate} ${time}`;
}

function sanitizeGeneratedName(value: string): string {
	const firstLine = value.split(/\r?\n/)[0] || "";
	return formatSessionName(
		firstLine.replace(/^\s*(name)\s*:\s*/i, "").replace(/^"+|"+$/g, "").replace(/^[`']+|[`']+$/g, "").trim()
	);
}

function normalizeContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return "";
	}

	return content
		.map((item) => {
			if (typeof item === "string") {
				return item;
			}
			if (!item || typeof item !== "object") {
				return "";
			}
			if ((item as { type?: string }).type === "text") {
				const rawText = (item as { text?: unknown }).text;
				return typeof rawText === "string" ? rawText : "";
			}
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

function buildSessionTranscript(ctx: ExtensionCommandContext): string {
	const entries: Array<{ type: string; message?: unknown }> =
		ctx?.sessionManager?.getEntries?.() ?? [];
	const leafId = ctx?.sessionManager?.getLeafId?.();
	const contextEntries =
		typeof ctx?.sessionManager?.buildContextEntries === "function"
			? ctx.sessionManager.buildContextEntries(entries, leafId as string | null | undefined)
			: entries;

	const lines: string[] = [];

	for (const entry of contextEntries) {
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
			continue;
		}
		const message = entry.message as { role?: string; content?: unknown };
		const role = message.role || "message";
		const prefix = role === "user" ? "U" : role === "assistant" ? "A" : role;
		const text = normalizeContent(message.content);
		if (!text.trim()) {
			continue;
		}
		lines.push(`${prefix}: ${text.replace(/\s+/g, " ").trim()}`);
	}

	const selectedLines = sampleTranscriptLines(lines);

	return selectedLines.length > 0 ? selectedLines.join("\n") : "No visible messages in this session.";
}

function sampleTranscriptLines(lines: string[]): string[] {
	if (lines.length <= AUTONAME_SAMPLE_SIZE * 3) {
		return lines;
	}

	const indexes = new Set<number>();
	const addRange = (start: number, endExclusive: number) => {
		for (let index = start; index < endExclusive; index += 1) {
			if (index >= 0 && index < lines.length) {
				indexes.add(index);
			}
		}
	};

	addRange(0, AUTONAME_SAMPLE_SIZE);

	const middleStart = Math.max(
		AUTONAME_SAMPLE_SIZE,
		Math.floor((lines.length - AUTONAME_SAMPLE_SIZE) / 2)
	);
	addRange(middleStart, middleStart + AUTONAME_SAMPLE_SIZE);

	addRange(lines.length - AUTONAME_SAMPLE_SIZE, lines.length);

	return [...indexes].sort((a, b) => a - b).map((index) => lines[index]);
}

async function generateSessionNameWithModel(
	ctx: ExtensionCommandContext,
	transcript: string
): Promise<string> {
	if (!ctx.model) {
		throw new Error("No active model. Use /model first.");
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}
	if (!auth.apiKey) {
		throw new Error(`No API key for ${ctx.model.provider}`);
	}

	const prompt = [
		"Using the context below, suggest a short and descriptive session name.",
		`Maximum ${AUTONAME_MAX_WORDS} words and ${AUTONAME_MAX_CHARS} characters.`,
		"No quotes, no prefixes, and one line only.",
		"",
		"Conversation context:",
		transcript,
		"",
		"Name:",
	].join("\n");

	const response = await complete(
		ctx.model,
		{
			systemPrompt:
				"You assign session names. Reply with only the title, one line, no quotes, no prefixes.",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			signal: ctx.signal,
			cacheRetention: "none",
			maxTokens: 64,
			reasoningEffort: "minimal",
		}
	);

	const raw = response.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	const final = sanitizeGeneratedName(raw);
	if (!final) {
		throw new Error("The model output did not return a valid name.");
	}

	return final;
}

async function applyAutoName(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string> {
	const transcript = buildSessionTranscript(ctx);
	const generatedName = await generateSessionNameWithModel(ctx, transcript);
	pi.setSessionName(generatedName);
	return generatedName;
}

async function renameHerdrIfAvailable(pi: ExtensionAPI, label: string): Promise<void> {
	try {
		await renameTab(pi, label);
	} catch (error) {
		if (!HERDR_ENV_ENABLED) {
			return;
		}
		throw error;
	}
}

async function renameTab(pi: ExtensionAPI, label: string): Promise<void> {
	if (!HERDR_ENV_ENABLED || !HERDR_TAB_ID) {
		throw new Error("herdr was not detected in this session. Use a herdr tab.");
	}

	const normalized = formatSessionName(label);
	const { code, stderr, stdout } = await pi.exec("herdr", ["tab", "rename", HERDR_TAB_ID, normalized]);
	if (code !== 0) {
		throw new Error(stderr || stdout || `herdr exited with code ${code}`);
	}
}

function getInitialTabLabelForSession(reason?: string): string {
	if (reason === "new") {
		return HERDR_NEW_SESSION_LABEL;
	}
	return defaultTabLabel();
}

function resolveTabLabel(
	pi: ExtensionAPI,
	explicitName?: string,
	options: { useSessionName?: boolean } = {}
): string {
	if (explicitName && explicitName.trim()) {
		return formatSessionName(explicitName);
	}

	if (options.useSessionName !== false) {
		const currentSessionName = pi.getSessionName();
		if (currentSessionName && currentSessionName.trim()) {
			return formatSessionName(currentSessionName);
		}
	}

	fallbackTabLabel = fallbackTabLabel || defaultTabLabel();
	return fallbackTabLabel;
}

async function applySessionBasedRename(
	pi: ExtensionAPI,
	options: { useSessionName?: boolean } = {}
): Promise<void> {
	if (!HERDR_ENV_ENABLED || !HERDR_TAB_ID) {
		return;
	}

	const label = resolveTabLabel(pi, undefined, options);
	try {
		await renameTab(pi, label);
	} catch (error) {
		console.error("Could not auto-rename herdr tab", error);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (event) => {
		fallbackTabLabel = getInitialTabLabelForSession(event?.reason);
		void applySessionBasedRename(pi, {
			useSessionName: event?.reason !== "new",
		});
	});

	pi.on("session_info_changed", (event) => {
		if (!HERDR_ENV_ENABLED || !HERDR_TAB_ID) {
			return;
		}
		const label = resolveTabLabel(pi, event.name, {
			useSessionName: true,
		});
		void renameTab(pi, label).catch(() => {
			// Avoid breaking the extension chain if herdr command fails transiently.
		});
	});

	pi.registerCommand("hname", {
		description: "Rename current herdr tab. Usage: /hname [name] (uses /name if empty; else generates one)",
		handler: async (args, ctx) => {
			const label = resolveTabNameOrGenerated(pi, args);
			try {
				await renameTab(pi, label);
				ctx.ui.notify(`Herdr tab renamed: ${label}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : "Could not rename the herdr tab";
				ctx.ui.notify(message, "error");
			}
		},
	});

	pi.registerCommand("auto-name", {
		description: "Automatically generate a session name from the current session context and apply it.",
		handler: async (_args, ctx) => {
			try {
				await renameHerdrIfAvailable(pi, AUTONAME_LOADING_LABEL);
				if (ctx?.isIdle?.() === false) {
					await ctx.waitForIdle();
				}
				const generatedName = await applyAutoName(pi, ctx);
				ctx.ui.notify(`Session renamed: ${generatedName}`, "info");
				await renameHerdrIfAvailable(pi, generatedName);
			} catch (error) {
				const message = error instanceof Error ? error.message : "Failed to generate/rename the session";
				ctx.ui.notify(message, "error");
			}
		},
	});
}

function resolveTabNameOrGenerated(pi: ExtensionAPI, args: string): string {
	const explicit = args.trim();
	return resolveTabLabel(pi, explicit);
}
