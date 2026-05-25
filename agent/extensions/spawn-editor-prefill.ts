/**
 * Spawn Editor Prefill Extension
 *
 * Tiny helper extension loaded via `pi -e` by the spawn command.
 * Reads a prompt from a temp file (path in PI_SPAWN_PROMPT_FILE env var)
 * and pre-fills the editor text so the user can review/edit before submitting.
 * Cleans up the temp file after reading.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, unlinkSync } from "node:fs";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const filePath = process.env.PI_SPAWN_PROMPT_FILE;
		if (!filePath) return;

		try {
			const text = readFileSync(filePath, "utf-8");
			unlinkSync(filePath);
			if (text && ctx.hasUI) {
				ctx.ui.setEditorText(text);
			}
		} catch {
			// File might not exist or be unreadable — ignore silently
		}
	});
}
