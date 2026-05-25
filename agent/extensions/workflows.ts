/**
 * Workflows Extension
 *
 * Commands for opening pi in new zellij panes.
 *
 * Usage:
 *   /split            - Fork current session into a new right-side zellij pane
 *   /spawn <task>     - Generate an elaborated prompt from the task using current
 *                       session context, then open a new pane with it pre-filled
 *                       in the editor for review
 *
 * Requirements:
 * - zellij (terminal multiplexer)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
	// Path to the tiny helper extension that pre-fills the editor in spawned sessions
	const PREFILL_EXTENSION = join(import.meta.dirname ?? __dirname, "spawn-editor-prefill.ts");

	// --- Shared helpers ---

	async function ensureZellij(ctx: ExtensionCommandContext): Promise<boolean> {
		const check = await pi.exec("which", ["zellij"], { timeout: 5000 });
		if (check.code !== 0) {
			ctx.ui.notify("zellij not found. This extension requires zellij.", "error");
			return false;
		}
		return true;
	}

	function getModelArg(ctx: ExtensionCommandContext): string[] {
		const model = ctx.model;
		if (!model) return [];
		const thinkingLevel = pi.getThinkingLevel();
		const thinkingSuffix = thinkingLevel && thinkingLevel !== "off" ? `:${thinkingLevel}` : "";
		return ["--model", `${model.provider}/${model.id}${thinkingSuffix}`];
	}

	function getModelFlag(ctx: ExtensionCommandContext): string {
		const model = ctx.model;
		if (!model) return "";
		const thinkingLevel = pi.getThinkingLevel();
		const thinkingSuffix = thinkingLevel && thinkingLevel !== "off" ? `:${thinkingLevel}` : "";
		return `--model "${model.provider}/${model.id}${thinkingSuffix}"`;
	}

	async function openRightPane(cmd: string): Promise<boolean> {
		const userShell = process.env.SHELL || "/bin/sh";
		const result = await pi.exec(
			"zellij",
			["action", "new-pane", "-d", "right", "--", userShell, "-l", "-c", cmd],
			{ timeout: 5000 },
		);
		return result.code === 0;
	}

	function writePromptFile(prompt: string): string {
		const filePath = join(tmpdir(), `pi-spawn-prompt-${Date.now()}.txt`);
		writeFileSync(filePath, prompt, "utf-8");
		return filePath;
	}

	// --- /split ---

	pi.registerCommand("split", {
		description: "Fork current session into a new right-side zellij pane",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("split requires interactive mode", "error");
				return;
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("No active session to split", "error");
				return;
			}

			if (!(await ensureZellij(ctx))) return;

			const modelFlag = getModelFlag(ctx);
			const cmd = `cd "${ctx.cwd}" && pi --fork "${sessionFile}" ${modelFlag}`;

			if (!(await openRightPane(cmd))) {
				ctx.ui.notify("Failed to open zellij pane", "error");
			}
		},
	});

	// --- /spawn ---

	pi.registerCommand("spawn", {
		description: "Spawn a new pi session in a right pane with an elaborated prompt",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("spawn requires interactive mode", "error");
				return;
			}

			const task = args?.trim();
			if (!task) {
				ctx.ui.notify("Usage: /spawn <task description>", "error");
				return;
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("No active session", "error");
				return;
			}

			if (!(await ensureZellij(ctx))) return;

			ctx.ui.setStatus("spawn", "⏳ Generating prompt for spawned session…");

			// Use pi -p --fork to elaborate the task in a separate process.
			// This gives the elaboration LLM full conversation context from the fork
			// without polluting the current session.
			const elaborationPrompt = [
				`Create a self-contained, detailed prompt for a fresh coding session that will work on this task:`,
				``,
				`"""`,
				task,
				`"""`,
				``,
				`The prompt must include all necessary context, constraints, and instructions for an independent session.`,
				`You may use context from our current conversation to inform the prompt.`,
				`Do NOT reference this conversation — the new session starts fresh.`,
				``,
				`OUTPUT ONLY the prompt text. No preamble, no explanation, no markdown code fences.`,
			].join("\n");

			// Redirect fork's session file to a temp dir so we don't pollute session storage.
			// --fork + --no-session is not allowed, so we use --session-dir instead.
			const tmpSessionDir = join(tmpdir(), `pi-spawn-session-${Date.now()}`);
			mkdirSync(tmpSessionDir, { recursive: true });

			const modelArgs = getModelArg(ctx);
			const forkResult = await pi.exec(
				"pi",
				[
					"-p",
					"--fork", sessionFile,
					"--session-dir", tmpSessionDir,
					...modelArgs,
					elaborationPrompt,
				],
				{ timeout: 120_000 },
			);

			// Clean up the temp fork session
			try { rmSync(tmpSessionDir, { recursive: true, force: true }); } catch {}

			if (forkResult.code !== 0 || !forkResult.stdout.trim()) {
				ctx.ui.setStatus("spawn", undefined);
				ctx.ui.notify("Failed to generate prompt", "error");
				return;
			}

			const elaboratedPrompt = forkResult.stdout.trim();

			// Write to temp file for the prefill extension to read
			const promptFile = writePromptFile(elaboratedPrompt);

			const modelFlag = getModelFlag(ctx);
			const cmd = [
				`cd "${ctx.cwd}"`,
				`&&`,
				`PI_SPAWN_PROMPT_FILE="${promptFile}"`,
				`pi`,
				modelFlag,
				`-e "${PREFILL_EXTENSION}"`,
			].join(" ");

			const success = await openRightPane(cmd);

			ctx.ui.setStatus("spawn", undefined);

			if (success) {
				ctx.ui.notify("Spawned new session in right pane", "info");
			} else {
				ctx.ui.notify("Failed to open zellij pane", "error");
				try {
					unlinkSync(promptFile);
				} catch {}
			}
		},
	});
}
