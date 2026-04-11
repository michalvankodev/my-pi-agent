/**
 * Split Extension
 *
 * Opens a new zellij pane on the right with a forked copy of the current session.
 * Continue working in the original pane while the new fork diverges independently.
 *
 * Usage:
 *   /split   - Fork current session into a new right-side zellij pane
 *
 * Requirements:
 * - zellij (terminal multiplexer)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
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

			// Check for zellij
			const zellijCheck = await pi.exec("which", ["zellij"], { timeout: 5000 });
			if (zellijCheck.code !== 0) {
				ctx.ui.notify("zellij not found. This extension requires zellij.", "error");
				return;
			}

			// Build model flag: provider/id:thinking
			const model = ctx.model;
			let modelFlag = "";
			if (model) {
				const thinkingLevel = pi.getThinkingLevel();
				const thinkingSuffix = thinkingLevel && thinkingLevel !== "off" ? `:${thinkingLevel}` : "";
				modelFlag = `--model "${model.provider}/${model.id}${thinkingSuffix}"`;
			}

			// Build the command
			const cmd = `cd "${ctx.cwd}" && pi --fork "${sessionFile}" ${modelFlag}`;

			const userShell = process.env.SHELL || "/bin/sh";

			const result = await pi.exec(
				"zellij",
				["action", "new-pane", "-d", "right", "--", userShell, "-l", "-c", cmd],
				{ timeout: 5000 },
			);

			if (result.code !== 0) {
				ctx.ui.notify("Failed to open zellij pane", "error");
			}
		},
	});
}
