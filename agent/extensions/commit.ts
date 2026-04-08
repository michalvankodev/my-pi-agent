/**
 * Git Commit Extension
 *
 * Generates conventional commit messages using a spawned pi instance, then
 * opens the editor for review in the same zellij pane. Commits after editor
 * closes.
 *
 * Usage:
 *   /commit                    - Generate commit message from staged changes + session context
 *   /commit <additional info>  - Include additional context in the message
 *
 * The command:
 * 1. Checks for staged changes (fails if none)
 * 2. Writes diff + session context + system prompt to temp files
 * 3. Spawns a new zellij pane immediately with a shell script that:
 *    a. Pipes prompt into `pi -p --no-session --no-extensions --no-tools` → COMMIT_EDITMSG
 *    b. Opens $EDITOR on COMMIT_EDITMSG for review
 *    c. Commits with the final message (unless emptied)
 *
 * Configuration: agents/commit.md with frontmatter:
 *   ---
 *   model: zai/glm-4.7-flash
 *   thinking: off
 *   ---
 *   <system prompt body for commit message generation>
 *
 * Falls back to extensions/commit.json for legacy config, then session defaults.
 *
 * Requirements:
 * - zellij (terminal multiplexer)
 * - $EDITOR environment variable or git config core.editor
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const MAX_DIFF_SIZE = 50000; // ~50KB max diff to send to LLM
const MAX_SESSION_MESSAGES = 10; // Last N user messages to include as context
const MAX_MESSAGE_LENGTH = 500; // Truncate each user message to this many chars
const COMMIT_TMP_PREFIX = "pi-commit-";

/**
 * Parse simple YAML-like frontmatter from a string.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const frontmatter: Record<string, string> = {};
	let body = content;

	if (content.startsWith("---")) {
		const endIdx = content.indexOf("---", 3);
		if (endIdx !== -1) {
			const yaml = content.slice(3, endIdx).trim();
			body = content.slice(endIdx + 3).trim();
			for (const line of yaml.split("\n")) {
				const colonIdx = line.indexOf(":");
				if (colonIdx !== -1) {
					const key = line.slice(0, colonIdx).trim();
					let val = line.slice(colonIdx + 1).trim();
					if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
						val = val.slice(1, -1);
					}
					frontmatter[key] = val;
				}
			}
		}
	}

	return { frontmatter, body };
}

/**
 * Load commit configuration from agents/commit.md, falling back to
 * extensions/commit.json. Returns { model, thinking, systemPrompt }.
 */
function loadCommitConfig(): { model?: string; thinking?: string; systemPrompt: string } {
	const defaultSystemPrompt = `You are a commit message generator. Generate a conventional commit message based on the git diff and context provided.

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

	// Try agents/commit.md first
	const mdPath = path.join(getAgentDir(), "agents", "commit.md");
	if (existsSync(mdPath)) {
		try {
			const raw = readFileSync(mdPath, "utf-8");
			const { frontmatter, body } = parseFrontmatter(raw);
			return {
				model: frontmatter.model,
				thinking: frontmatter.thinking || frontmatter.thinkingLevel,
				systemPrompt: body.trim() || defaultSystemPrompt,
			};
		} catch (err) {
			console.error("[commit] Failed to read agents/commit.md:", err);
		}
	}

	// Fallback to legacy extensions/commit.json
	const jsonPath = path.join(getAgentDir(), "extensions", "commit.json");
	if (existsSync(jsonPath)) {
		try {
			const raw = readFileSync(jsonPath, "utf-8");
			const config = JSON.parse(raw) as { model?: string; thinkingLevel?: string };
			return {
				model: config.model,
				thinking: config.thinkingLevel,
				systemPrompt: defaultSystemPrompt,
			};
		} catch (err) {
			console.error("[commit] Failed to read extensions/commit.json:", err);
		}
	}

	return { systemPrompt: defaultSystemPrompt };
}

/**
 * Extract recent user messages from the session branch for context.
 */
function extractSessionContext(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	const recentMessages: string[] = [];
	let messageCount = 0;

	for (let i = branch.length - 1; i >= 0 && messageCount < MAX_SESSION_MESSAGES; i--) {
		const entry = branch[i];
		if (entry.type === "message") {
			const msg = entry.message;
			if ("role" in msg && msg.role === "user") {
				const textParts = msg.content
					.filter((c: { type: string; text?: string }): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text);
				if (textParts.length > 0) {
					recentMessages.unshift(textParts.join("\n").substring(0, MAX_MESSAGE_LENGTH));
					messageCount++;
				}
			}
		}
	}

	return recentMessages.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Generate conventional commit message using pi with session context, then open editor in zellij pane",
		handler: async (args: string, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("commit requires interactive mode", "error");
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
			if (diff.length > MAX_DIFF_SIZE) {
				diff = diff.substring(0, MAX_DIFF_SIZE) + "\n... [diff truncated]";
			}

			// Load config
			const config = loadCommitConfig();

			// Determine model and thinking flags for pi invocation
			const modelFlag = config.model ? `--model "${config.model}"` : "";
			const thinkingFlag = config.thinking ? `--thinking ${config.thinking}` : "";

			// Resolve git repo toplevel for cd-ing in the script
			const toplevelResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 5000 });
			if (toplevelResult.code !== 0) {
				ctx.ui.notify("Failed to find git repo root", "error");
				return;
			}
			const gitRoot = toplevelResult.stdout.trim();

			// Determine editor
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

			// Validate editor exists
			const editorBase = editor.split(/\s+/)[0];
			const editorCheck = await pi.exec("which", [editorBase], { timeout: 5000 });
			if (editorCheck.code !== 0) {
				ctx.ui.notify(`Editor '${editorBase}' not found in PATH`, "error");
				return;
			}

			// Create temp directory and files
			const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), COMMIT_TMP_PREFIX));
			const commitMsgFile = path.join(tmpDir, "COMMIT_EDITMSG");
			const promptFile = path.join(tmpDir, "prompt.txt");
			const systemPromptFile = path.join(tmpDir, "system-prompt.txt");
			const doneMarker = path.join(tmpDir, "DONE");

			// Extract recent user messages for context
			const sessionContext = extractSessionContext(ctx);

			// Build the user prompt
			let userPrompt = "Generate a commit message for the following staged changes:\n\n";
			userPrompt += "```diff\n" + diff + "\n```\n\n";

			if (sessionContext) {
				userPrompt += "Recent session context (user requests that led to these changes):\n\n";
				userPrompt += sessionContext + "\n\n";
			}

			if (args.trim()) {
				userPrompt += "Additional context provided by user:\n" + args.trim() + "\n\n";
			}

			// Write files for the shell script
			await fs.writeFile(promptFile, userPrompt, "utf-8");
			await fs.writeFile(systemPromptFile, config.systemPrompt, "utf-8");

			// Shell script that runs in the zellij pane:
			// 1. Pipe prompt into pi -p → COMMIT_EDITMSG
			// 2. Open editor for review
			// 3. Git commit with final message
			const errorLog = path.join(tmpDir, "pi-error.log");

			// Detect user's shell (fish has universal variables with API keys)
			const userShell = process.env.SHELL || "/bin/sh";

			const shellScript = `#!/bin/sh
set -e
cd "${gitRoot}"

echo "🤖 Generating commit message..."
SP=$(cat "${systemPromptFile}")
cat "${promptFile}" | pi -p \\
  --no-session \\
  --no-extensions \\
  --no-tools \\
  ${modelFlag} \\
  ${thinkingFlag} \
  --system-prompt "$SP" \
  > "${commitMsgFile}" 2> "${errorLog}" || true

if [ ! -s "${commitMsgFile}" ]; then
  echo ""
  echo "❌ Failed to generate commit message."
  if [ -s "${errorLog}" ]; then
    echo "   Error output:"
    cat "${errorLog}"
  fi
  echo ""
  echo "   You can still edit manually: ${commitMsgFile}"
  echo "   Then run: git commit -F ${commitMsgFile}"
  echo ""
  touch "${doneMarker}"
  echo "Press Enter to close..."
  read -r
  exit 1
fi

echo "✅ Commit message generated. Opening editor..."
# Prepend diffstat as comments so the editor shows what's being committed
DIFFSTAT=$(git diff --staged --stat)
if [ -n "$DIFFSTAT" ]; then
  MSG=$(cat "${commitMsgFile}")
  COMMENTED=$(echo "$DIFFSTAT" | sed 's/^/# /')
  printf '%s\n\n# Changes to be committed:\n%s\n' "$MSG" "$COMMENTED" > "${commitMsgFile}"
fi
echo ""
${editor} "${commitMsgFile}"

# Strip comment lines, then check if anything is left
FILTERED=$(grep -v '^#' "${commitMsgFile}" | tr -d '[:space:]')
if [ -z "$FILTERED" ]; then
  echo "🚫 Commit aborted: empty message after editing."
  touch "${doneMarker}"
  echo "Press Enter to close..."
  read -r
  exit 0
fi

# Commit using only non-comment lines (preserve blank lines in body)
grep -v '^#' "${commitMsgFile}" > "${commitMsgFile}.clean"
if git commit -F "${commitMsgFile}.clean"; then
  HASH=$(git rev-parse --short HEAD)
  FIRST_LINE=$(head -1 "${commitMsgFile}")
  echo ""
  echo "✅ Committed: $HASH: $FIRST_LINE"
  touch "${doneMarker}"
  rm -rf "${tmpDir}"
else
  echo ""
  echo "❌ git commit failed. Message preserved at: ${commitMsgFile}"
  touch "${doneMarker}"
fi

echo ""
echo "Press Enter to close..."
read -r
`;

			const scriptFile = path.join(tmpDir, "commit.sh");
			await fs.writeFile(scriptFile, shellScript, { mode: 0o755, encoding: "utf-8" });

			ctx.ui.notify("Opening zellij pane for commit generation...", "info");

			// Spawn zellij pane — it handles everything
			const zellijResult = await pi.exec(
				"zellij",
				["action", "new-pane", "-d", "right", "--close-on-exit", "--", userShell, "-l", "-c", `sh "${scriptFile}"`],
				{ timeout: 5000 },
			);

			if (zellijResult.code !== 0) {
				ctx.ui.notify("Failed to open zellij pane", "error");
				await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
				return;
			}

			// Background: wait for done marker and notify
			waitForDone(pi, ctx, tmpDir, doneMarker, commitMsgFile).catch((err) => {
				console.error("[commit] Wait error:", err);
			});
		},
	});
}

/**
 * Wait for the commit workflow to finish, then notify the user.
 */
async function waitForDone(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	tmpDir: string,
	doneMarker: string,
	commitMsgFile: string,
): Promise<void> {
	const startTime = Date.now();
	const timeout = 600000; // 10 minutes (generation + editing)

	while (Date.now() - startTime < timeout) {
		try {
			await fs.access(doneMarker);
			// Done marker exists
			try {
				const msg = await fs.readFile(commitMsgFile, "utf-8");
				const firstLine = msg.trim().split("\n")[0];
				ctx.ui.notify(`Committed: ${firstLine}`, "success");
			} catch {
				// tmpDir cleaned up = successful commit
				ctx.ui.notify("Committed successfully!", "success");
			}
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}

	ctx.ui.notify("Commit workflow timed out (10 min)", "warn");
	ctx.ui.notify(`Commit message preserved at: ${commitMsgFile}`, "info");
}
