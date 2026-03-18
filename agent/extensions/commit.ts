/**
 * Git Commit Extension
 *
 * Generates conventional commit messages using LLM and opens git editor for review
 * in a new zellij pane.
 *
 * Usage:
 *   /commit                    - Generate commit message from staged changes + session context
 *   /commit <additional info>  - Include additional context in the message
 *
 * The command:
 * 1. Checks for staged changes (fails if none)
 * 2. Gets git diff of staged changes
 * 3. Extracts relevant context from session messages
 * 4. Generates a conventional commit message using LLM
 * 5. Spawns a new zellij pane with $EDITOR for review
 * 6. Commits after editor closes (unless message was emptied)
 *
 * Requirements:
 * - zellij (terminal multiplexer)
 * - $EDITOR environment variable or git config core.editor
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { complete, type UserMessage } from "@mariozechner/pi-ai";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SYSTEM_PROMPT = `You are a commit message generator. Generate a conventional commit message based on the git diff and context provided.

Follow these rules:
1. First line: conventional commit format (type: description)
   - Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert
   - Keep it under 72 characters
   - Use imperative mood ("add feature" not "added feature")
   - Don't end with a period

2. Blank line after the first line.

3. Body: A summary of changes (4-20 lines)
   - Explain WHAT changed and WHY (not how)
   - Use bullet points for multiple changes
   - Be specific but concise
   - Include relevant context from the session

4. If additional context is provided by the user, incorporate it naturally.

Output ONLY the commit message, nothing else. Do not include code blocks or markdown.`;

const MAX_DIFF_SIZE = 50000; // ~50KB max diff to send to LLM
const MAX_SESSION_MESSAGES = 10; // Last N user messages to include

export default function (pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Generate conventional commit message and open editor in zellij pane for review",
		handler: async (args: string, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("commit requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// Check for zellij
			const zellijCheck = await pi.exec("which", ["zellij"], { timeout: 5000 });
			if (zellijCheck.code !== 0) {
				ctx.ui.notify(
					"zellij not found. This extension requires zellij to open an editor pane.",
					"error",
				);
				return;
			}

			// Check if we're in a git repository
			const gitCheck = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], {
				timeout: 5000,
			});
			if (gitCheck.code !== 0 || gitCheck.stdout.trim() !== "true") {
				ctx.ui.notify("Not a git repository", "error");
				return;
			}

			// Check for staged changes
			const stagedCheck = await pi.exec("git", ["diff", "--staged", "--stat"], { timeout: 10000 });
			if (stagedCheck.code !== 0) {
				ctx.ui.notify("Failed to check staged changes", "error");
				return;
			}

			if (!stagedCheck.stdout.trim()) {
				ctx.ui.notify("No staged changes. Use 'git add' to stage changes first.", "error");
				return;
			}

			// Get the staged diff
			const diffResult = await pi.exec("git", ["diff", "--staged"], { timeout: 30000 });
			if (diffResult.code !== 0) {
				ctx.ui.notify("Failed to get staged diff", "error");
				return;
			}

			let diff = diffResult.stdout;
			// Truncate if too large
			if (diff.length > MAX_DIFF_SIZE) {
				diff = diff.substring(0, MAX_DIFF_SIZE) + "\n... [diff truncated]";
			}

			// Get session context (recent user messages)
			const branch = ctx.sessionManager.getBranch();
			const recentMessages: string[] = [];
			let messageCount = 0;

			for (let i = branch.length - 1; i >= 0 && messageCount < MAX_SESSION_MESSAGES; i--) {
				const entry = branch[i];
				if (entry.type === "message") {
					const msg = entry.message;
					if ("role" in msg && msg.role === "user") {
						const textParts = msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text);
						if (textParts.length > 0) {
							recentMessages.unshift(textParts.join("\n"));
							messageCount++;
						}
					}
				}
			}

			// Build the prompt
			let prompt = "Generate a commit message for the following staged changes:\n\n";
			prompt += "```diff\n" + diff + "\n```\n\n";

			if (recentMessages.length > 0) {
				prompt += "Recent session context (user requests that led to these changes):\n\n";
				for (const msg of recentMessages) {
					prompt += "> " + msg.substring(0, 500) + (msg.length > 500 ? "..." : "") + "\n\n";
				}
			}

			const additionalContext = args.trim();
			if (additionalContext) {
				prompt += "Additional context provided by user:\n" + additionalContext + "\n\n";
			}

			// Generate commit message using LLM
			const commitMessage = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(
					tui,
					theme,
					`Generating commit message using ${ctx.model!.id}...`,
				);
				loader.onAbort = () => done(null);

				const generate = async () => {
					const apiKey = await ctx.modelRegistry.getApiKey(ctx.model!);
					const userMessage: UserMessage = {
						role: "user",
						content: [{ type: "text", text: prompt }],
						timestamp: Date.now(),
					};

					const response = await complete(
						ctx.model!,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{ apiKey, signal: loader.signal },
					);

					if (response.stopReason === "aborted") {
						return null;
					}

					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				};

				generate()
					.then(done)
					.catch((err) => {
						console.error("Commit generation error:", err);
						done(null);
					});

				return loader;
			});

			if (commitMessage === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Create temp files for commit message and sync marker
			const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-commit-"));
			const commitMsgFile = path.join(tmpDir, "COMMIT_EDITMSG");
			const doneMarker = path.join(tmpDir, "DONE");

			try {
				await fs.writeFile(commitMsgFile, commitMessage + "\n");

				// Determine the editor to use
				// Priority: $EDITOR > git config core.editor > fallback to vi
				let editor = process.env.EDITOR || process.env.VISUAL;
				if (!editor) {
					const gitEditor = await pi.exec("git", ["config", "core.editor"], { timeout: 5000 });
					if (gitEditor.code === 0 && gitEditor.stdout.trim()) {
						editor = gitEditor.stdout.trim();
					}
				}
				if (!editor) {
					editor = "vi";
				}

				// Validate editor exists before spawning zellij
				const editorBase = editor.split(/\s+/)[0]; // Handle "code --wait" case
				const editorCheck = await pi.exec("which", [editorBase], { timeout: 5000 });
				if (editorCheck.code !== 0) {
					ctx.ui.notify(`Editor '${editorBase}' not found in PATH`, "error");
					await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
					return;
				}

				ctx.ui.notify(`Opening editor (${editor}) in new zellij pane...`, "info");

				// Handle editors with arguments (e.g., "code --wait" or "vim -g")
				// We use a shell wrapper to:
				// 1. Run the editor on the commit message file
				// 2. Create a done marker file when finished
				// This lets us wait for editing to complete since zellij returns immediately
				const shellScript = `${editor} "${commitMsgFile}" && touch "${doneMarker}"`;

				const zellijResult = await pi.exec(
					"zellij",
					["action", "new-pane", "-f", "--close-on-exit", "--", "sh", "-c", shellScript],
					{ timeout: 5000 }, // zellij returns quickly, we don't wait for editor here
				);

				if (zellijResult.code !== 0) {
					ctx.ui.notify("Failed to open zellij pane", "error");
					await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
					return;
				}

				// Wait for the done marker (editor finished)
				ctx.ui.notify("Waiting for editor to close...", "info");
				const startTime = Date.now();
				const timeout = 300000; // 5 minutes
				let markerExists = false;

				while (Date.now() - startTime < timeout) {
					try {
						await fs.access(doneMarker);
						markerExists = true;
						break;
					} catch {
						// Marker doesn't exist yet, wait and retry
						await new Promise((resolve) => setTimeout(resolve, 500));
					}
				}

				if (!markerExists) {
					ctx.ui.notify("Editor timed out (5 minutes)", "error");
					ctx.ui.notify(
						`Commit message preserved at: ${commitMsgFile}`,
						"info",
					);
					return;
				}

				// Read back the (possibly edited) commit message
				let editedMessage = await fs.readFile(commitMsgFile, "utf-8");
				editedMessage = editedMessage.trim();

				if (!editedMessage) {
					ctx.ui.notify("Commit aborted: empty message", "info");
					await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
					return;
				}

				// Commit with the edited message
				const commitResult = await pi.exec("git", ["commit", "-F", commitMsgFile], {
					timeout: 30000,
				});

				if (commitResult.code === 0) {
					ctx.ui.notify("Committed successfully!", "success");
					// Show short commit hash
					const hashResult = await pi.exec("git", ["rev-parse", "--short", "HEAD"], {
						timeout: 5000,
					});
					if (hashResult.code === 0) {
						const firstLine = editedMessage.split("\n")[0];
						ctx.ui.notify(`${hashResult.stdout.trim()}: ${firstLine}`, "info");
					}

					// Cleanup temp files on success
					try {
						await fs.rm(tmpDir, { recursive: true, force: true });
					} catch {
						// Ignore cleanup errors
					}
				} else {
					ctx.ui.notify(
						`Commit failed: ${commitResult.stderr || commitResult.stdout || "unknown error"}`,
						"error",
					);
					ctx.ui.notify(
						`Commit message preserved at: ${commitMsgFile}`,
						"info",
					);
				}
			} catch (error) {
				// On unexpected error, leave temp files for recovery
				ctx.ui.notify(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
				ctx.ui.notify(
					`Commit message preserved at: ${commitMsgFile}`,
					"info",
				);
			}
		},
	});
}