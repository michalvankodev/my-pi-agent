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
 * 2. Condenses the diff programmatically (collapses large deletions, keeps additions)
 * 3. Writes condensed diff + stat + session context + system prompt to temp files
 * 4. Spawns a new zellij pane immediately with a shell script that:
 *    a. Pipes prompt into `pi -p --no-session --no-extensions --no-tools --no-context-files` → COMMIT_EDITMSG
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
 *
 * Requirements:
 * - zellij (terminal multiplexer)
 * - $EDITOR environment variable or git config core.editor
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir, parseFrontmatter, truncateHead, formatSize } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const MAX_DIFF_SIZE = 25000; // ~25KB max condensed diff to send to LLM
const MAX_DELETION_LINES = 20; // Max consecutive deletion lines per hunk before collapsing
const MAX_SESSION_MESSAGES = 10; // Last N user messages to include as context
const MAX_MESSAGE_LENGTH = 500; // Truncate each user message to this many chars
const COMMIT_TMP_PREFIX = "pi-commit-";

/**
 * File patterns to exclude from the diff sent to the LLM.
 * These are generated/dependency files whose contents are noise for commit messages.
 * The stat summary still shows they changed, but the diff body is skipped.
 */
const NOISY_FILE_PATTERNS: RegExp[] = [
	/(^|\/)(package-lock|npm-shrinkwrap)\.json$/,
	/(^|\/)yarn\.lock$/,
	/(^|\/)pnpm-lock\.yaml$/,
	/(^|\/)bun\.lockb?$/,
	/(^|\/)Cargo\.lock$/,
	/(^|\/)Gemfile\.lock$/,
	/(^|\/)composer\.lock$/,
	/(^|\/)go\.sum$/,
	/(^|\/)mix\.lock$/,
	/(^|\/)Podfile\.lock$/,
	/(^|\/)poetry\.lock$/,
	/(^|\/)uv\.lock$/,
	/(^|\/)pdm\.lock$/,
	/(^|\/)conan\.lock$/,
	/(^|\/)\.pnp\.c?js$/,
];

/**
 * Check if a file path matches any noisy file pattern.
 */
function isNoisyFile(filePath: string): boolean {
	return NOISY_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}



/**
 * Load commit configuration from agents/commit.md.
 * Returns { model, thinking, systemPrompt }.
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

	const mdPath = path.join(getAgentDir(), "agents", "commit.md");
	if (existsSync(mdPath)) {
		try {
			const raw = readFileSync(mdPath, "utf-8");
			const { frontmatter, body } = parseFrontmatter(raw);
			return {
				model: frontmatter.model as string | undefined,
				thinking: (frontmatter.thinking || frontmatter.thinkingLevel) as string | undefined,
				systemPrompt: (body as string).trim() || defaultSystemPrompt,
			};
		} catch (err) {
			console.error("[commit] Failed to read agents/commit.md:", err);
		}
	}

	return { systemPrompt: defaultSystemPrompt };
}

/**
 * Condense a git diff by collapsing large deletion blocks, replacing
 * purely-deleted files with one-liner summaries, and skipping noisy
 * lock/generated files.
 *
 * Strategy:
 * - Skip lock/generated files (Cargo.lock, package-lock.json, etc.)
 *   with a one-liner placeholder; the stat summary still shows them
 * - For files that are purely deletions (no additions in any hunk):
 *   replace with a single "--- deleted: path (N lines removed)" line
 * - For mixed files: within each hunk, collapse runs of deletion lines
 *   beyond MAX_DELETION_LINES into "... (N lines removed)"
 * - Keep addition lines and context lines verbatim
 */
function condenseDiff(diff: string): string {
	// Split into file sections (each starts with "diff --git")
	const fileSections = diff.split(/(?=^diff --git )/m);

	return fileSections
		.map((section) => {
			if (!section.startsWith("diff --git")) return section;

			// Extract file path from the header
			const pathMatch = section.match(/^diff --git a\/(.+?) b\/.+$/m);
			const filePath = pathMatch ? pathMatch[1] : "unknown";

			// Skip noisy lock/generated files entirely
			if (isNoisyFile(filePath)) {
				return `diff --git a/${filePath} b/${filePath}\n--- [lock file skipped]`;
			}

			// Check if this is a pure deletion (file deleted entirely)
			if (/^deleted file mode/m.test(section)) {
				const delLines = countLines(section, "-");
				return `diff --git a/${filePath} b/${filePath}\ndeleted file mode\n--- ${filePath}\n+++ /dev/null\n@@ -1,${delLines} +0,0 @@\n--- deleted: ${filePath} (${delLines} lines removed)`;
			}

			// Check if this is a pure rename with no content changes
			if (/^similarity index 100%/m.test(section)) {
				return section; // Keep as-is, it's small
			}

			// Count additions and deletions across all hunks
			const addLines = countLines(section, "+");
			const delLines = countLines(section, "-");

			// Pure deletion file (no additions in any hunk)
			if (addLines === 0 && delLines > MAX_DELETION_LINES) {
				return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n--- modified: ${filePath} (${delLines} lines removed, no additions)`;
			}

			// Mixed file: condense individual hunks
			return condenseHunks(section, filePath);
		})
		.join("");
}

/**
 * Count lines with a given prefix in a diff section,
 * excluding the diff header lines.
 */
function countLines(section: string, prefix: string): number {
	let count = 0;
	for (const line of section.split("\n")) {
		if (line.startsWith(prefix) && !line.startsWith(prefix + prefix)) {
			count++;
		}
	}
	return count;
}

/**
 * Condense deletion runs within hunks of a file diff.
 * Keeps additions and context lines verbatim.
 */
function condenseHunks(section: string, _filePath: string): string {
	const lines = section.split("\n");
	const result: string[] = [];
	let inDeletionRun = false;
	let deletionCount = 0;
	let deletionBuffer: string[] = [];

	for (const line of lines) {
		if (line.startsWith("-") && !line.startsWith("--")) {
			// Deletion line
			if (!inDeletionRun) {
				inDeletionRun = true;
				deletionCount = 0;
				deletionBuffer = [];
			}
			deletionCount++;
			if (deletionCount <= MAX_DELETION_LINES) {
				deletionBuffer.push(line);
			}
		} else {
			// Non-deletion line: flush any pending deletion run
			if (inDeletionRun) {
				result.push(...deletionBuffer);
				if (deletionCount > MAX_DELETION_LINES) {
					result.push(`... (${deletionCount - MAX_DELETION_LINES} more lines removed)`);
				}
				inDeletionRun = false;
				deletionCount = 0;
				deletionBuffer = [];
			}
			result.push(line);
		}
	}

	// Flush trailing deletion run
	if (inDeletionRun) {
		result.push(...deletionBuffer);
		if (deletionCount > MAX_DELETION_LINES) {
			result.push(`... (${deletionCount - MAX_DELETION_LINES} more lines removed)`);
		}
	}

	return result.join("\n");
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
	// Register custom renderer for commit history entries in the session tree
	pi.registerMessageRenderer("commit", (message, _options, theme) => {
		const hash = message.details?.hash ?? "?";
		const firstLine = message.details?.message ?? "commit";
		return new Text(theme.fg("success", `✅ Commit ${hash}: ${firstLine}`), 0, 0);
	});

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

			// Condense the diff programmatically
			const condensed = condenseDiff(diffResult.stdout);
			const truncation = truncateHead(condensed, { maxBytes: MAX_DIFF_SIZE });
			let diff = truncation.content;
			if (truncation.truncated) {
				diff += `\n... [diff truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}]`;
			}

			// Get the stat summary (always useful high-level context)
			const statSummary = stagedCheck.stdout.trim();

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
			const statusFile = path.join(os.tmpdir(), `${COMMIT_TMP_PREFIX}status-${path.basename(tmpDir)}`);

			// Extract recent user messages for context
			const sessionContext = extractSessionContext(ctx);

			// Build the user prompt
			let userPrompt = "Generate a commit message for the following staged changes:\n\n";

			// Always include stat summary for reliable high-level picture
			userPrompt += "Files changed:\n```\n" + statSummary + "\n```\n\n";

			userPrompt += "Diff:\n```diff\n" + diff + "\n```\n\n";

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

			// Model label for status notifications and shell script display
			const modelLabel = config.model || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown");

			// Progress file: shell script writes timing/error info here for TUI to read
			const progressFile = path.join(tmpDir, "progress");

			// Shell script that runs in the zellij pane:
			// 1. Pipe prompt into pi -p → COMMIT_EDITMSG
			//    - pi runs in background so we can show live progress
			//    - stderr is tee'd to error log AND monitored for display
			// 2. Open editor for review
			// 3. Git commit with final message
			const errorLog = path.join(tmpDir, "pi-error.log");

			// Detect user's shell (fish has universal variables with API keys)
			const userShell = process.env.SHELL || "/bin/sh";

			const shellScript = `#!/bin/sh
cd "${gitRoot}"

echo "generating" > "${statusFile}"
echo "0" > "${progressFile}"

echo "🤖 Generating commit message with ${modelLabel}..."
PROMPT_SIZE=\$(wc -c < "${promptFile}" | tr -d ' ')
PROMPT_LINES=\$(wc -l < "${promptFile}" | tr -d ' ')
echo "   Input: \${PROMPT_SIZE} bytes, \${PROMPT_LINES} lines"
echo ""

SP=\$(cat "${systemPromptFile}")

# Use a FIFO so pi line-buffers output (not full-buffered like a file)
mkfifo "${tmpDir}/pipe" || exit 1
cat "${tmpDir}/pipe" > "${commitMsgFile}" &
CAT_PID=\$!

# Start pi in background, stderr goes to log file
START=\$(date +%s)
cat "${promptFile}" | pi -p \\
  --no-session \\
  --no-extensions \\
  --no-tools \\
  --no-context-files \\
  ${modelFlag} \\
  ${thinkingFlag} \
  --append-system-prompt "\$SP" \
  > "${tmpDir}/pipe" 2> "${errorLog}" &
PI_PID=\$!

# Monitor loop: show elapsed time, output growth, stderr, live preview
LAST_ERR_LINES=0
PREV_OUT_LINES=0
while kill -0 \$PI_PID 2>/dev/null; do
  NOW=\$(date +%s)
  ELAPSED=\$((NOW - START))
  echo "\$ELAPSED" > "${progressFile}"

  # Format elapsed time
  if [ \$ELAPSED -ge 60 ]; then
    MINS=\$((ELAPSED / 60))
    SECS=\$((ELAPSED % 60))
    TIME_FMT="\${MINS}m\${SECS}s"
  else
    TIME_FMT="\${ELAPSED}s"
  fi

  # Output file stats
  OUT_SIZE=0
  OUT_LINES=0
  if [ -f "${commitMsgFile}" ]; then
    OUT_SIZE=\$(wc -c < "${commitMsgFile}" | tr -d ' ')
    OUT_LINES=\$(wc -l < "${commitMsgFile}" | tr -d ' ')
  fi

  # Build header line
  if [ "\$OUT_SIZE" -gt 0 ]; then
    STATUS_LINE="⏳ \${TIME_FMT} — \${OUT_SIZE} bytes, \${OUT_LINES} lines"
  else
    STATUS_LINE="⏳ \${TIME_FMT} — waiting for response..."
  fi

  # Show new stderr lines (retries, rate limits)
  if [ -f "${errorLog}" ] && [ -s "${errorLog}" ]; then
    NEW_ERR_LINES=\$(wc -l < "${errorLog}" | tr -d ' ')
    if [ "\$NEW_ERR_LINES" -gt "\$LAST_ERR_LINES" ]; then
      tail -n \$((NEW_ERR_LINES - LAST_ERR_LINES)) "${errorLog}" | while IFS= read -r line; do
        printf "\r\x1b[K⚠  %s\n" "\$(echo "\$line" | head -c 120)"
      done
      LAST_ERR_LINES=\$NEW_ERR_LINES
    fi
  fi

  # Show last 7 lines of output as live preview when new lines arrive
  if [ "\$OUT_LINES" -gt 0 ] && [ "\$OUT_LINES" -ne "\$PREV_OUT_LINES" ]; then
    PREV_OUT_LINES=\$OUT_LINES
    printf "\r\x1b[K%s\n" "\$STATUS_LINE"
    echo "─── preview ───"
    tail -7 "${commitMsgFile}" | sed 's/^/  /'
    echo "───────────────"
  else
    printf "\r\x1b[K%s  " "\$STATUS_LINE"
  fi

  sleep 1
done

# Wait for pi to finish and get exit code
wait \$PI_PID
PI_EXIT=\$?
# Wait for the FIFO reader to finish flushing
wait \$CAT_PID 2>/dev/null || true
rm -f "${tmpDir}/pipe"
NOW=\$(date +%s)
ELAPSED=\$((NOW - START))
echo "\$ELAPSED" > "${progressFile}"

# Clear the progress line
printf "\r\x1b[K"

if [ ! -s "${commitMsgFile}" ]; then
  echo ""
  echo "❌ Failed to generate commit message (\${ELAPSED}s)."
  if [ -s "${errorLog}" ]; then
    echo "   Error output:"
    cat "${errorLog}"
  fi
  echo ""
  echo "   You can still edit manually: ${commitMsgFile}"
  echo "   Then run: git commit -F ${commitMsgFile}"
  echo ""
  echo "failed" > "${statusFile}"
  echo "Press Enter to close..."
  read -r
  echo "closed" > "${statusFile}"
  exit 1
fi

echo "✅ Message generated in \${ELAPSED}s. Opening editor..."
echo "editing" > "${statusFile}"
# Prepend diffstat as comments so the editor shows what's being committed
DIFFSTAT=\$(git diff --staged --stat)
if [ -n "\$DIFFSTAT" ]; then
  MSG=\$(cat "${commitMsgFile}")
  COMMENTED=\$(echo "\$DIFFSTAT" | sed 's/^/# /')
  printf '%s\n\n# Changes to be committed:\n%s\n' "\$MSG" "\$COMMENTED" > "${commitMsgFile}"
fi
echo ""
${editor} "${commitMsgFile}"

# Strip comment lines, then check if anything is left
FILTERED=\$(grep -v '^#' "${commitMsgFile}" | tr -d '[:space:]')
if [ -z "\$FILTERED" ]; then
  echo "🚫 Commit aborted: empty message after editing."
  echo "aborted" > "${statusFile}"
  echo "Press Enter to close..."
  read -r
  echo "closed" > "${statusFile}"
  exit 0
fi

# Commit using only non-comment lines (preserve blank lines in body)
grep -v '^#' "${commitMsgFile}" > "${commitMsgFile}.clean"

# Commit with retry loop on failure
while true; do
  cp "${commitMsgFile}.clean" "$(git rev-parse --git-dir)/COMMIT_EDITMSG"
  git commit -F "${commitMsgFile}.clean" > "${tmpDir}/commit-output.log" 2>&1
  COMMIT_EXIT=\$?
  if [ \$COMMIT_EXIT -eq 0 ]; then
    HASH=\$(git rev-parse --short HEAD)
    FIRST_LINE=\$(head -1 "${commitMsgFile}")
    echo ""
    echo "✅ Committed: \$HASH: \$FIRST_LINE"
    rm -rf "${tmpDir}"
    echo "committed" > "${statusFile}"
    break
  fi

  # Write failure output so main pi can display it
  cp "${tmpDir}/commit-output.log" "${tmpDir}/retry-error"
  echo "retrying" > "${statusFile}"

  echo ""
  echo "❌ git commit failed (exit code \$COMMIT_EXIT):"
  if [ -s "${tmpDir}/commit-output.log" ]; then
    echo ""
    sed 's/^/   /' "${tmpDir}/commit-output.log"
  fi
  echo ""
  echo "[R]etry  [E]dit  [A]bort"
  while true; do
    read -r ANSWER
    case "\$ANSWER" in
      [Rr]|""|retry)
        echo ""
        echo "🔄 Retrying..."
        break
        ;;
      [Ee]|edit)
        echo "editing" > "${statusFile}"
        ${editor} "${commitMsgFile}"
        FILTERED=\$(grep -v '^#' "${commitMsgFile}" | tr -d '[:space:]')
        if [ -z "\$FILTERED" ]; then
          echo "🚫 Commit aborted: empty message after editing."
          echo "aborted" > "${statusFile}"
          break 2
        fi
        grep -v '^#' "${commitMsgFile}" > "${commitMsgFile}.clean"
        echo ""
        echo "🔄 Retrying..."
        break
        ;;
      [Aa]|abort|*)
        echo "🚫 Commit aborted."
        echo "   Message preserved at: ${commitMsgFile}"
        echo "   Run \`git commit\` to retry with the saved message."
        echo "failed" > "${statusFile}"
        break 2
        ;;
    esac
  done
done

echo ""
echo "Press Enter to close..."
read -r
echo "closed" > "${statusFile}"
`;

			const scriptFile = path.join(tmpDir, "commit.sh");
			await fs.writeFile(scriptFile, shellScript, { mode: 0o755, encoding: "utf-8" });

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

			// Background: watch status file and notify
			watchStatus(pi, ctx, statusFile, progressFile, errorLog, commitMsgFile, modelLabel).catch((err) => {
				console.error("[commit] Watch error:", err);
			});
		},
	});
}

type CommitStatus = "generating" | "editing" | "retrying" | "committed" | "aborted" | "failed" | "closed";

/**
 * Format seconds into a human-readable duration.
 */
function formatDuration(seconds: number): string {
	if (seconds >= 60) {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}m${secs}s`;
	}
	return `${seconds}s`;
}

/**
 * Read the last meaningful line from the error log.
 */
async function readLastError(errorLog: string): Promise<string> {
	try {
		const content = await fs.readFile(errorLog, "utf-8");
		const lines = content.trim().split("\n").filter((l) => l.trim());
		if (lines.length === 0) return "";
		// Return last line, truncated
		return lines[lines.length - 1].substring(0, 120);
	} catch {
		return "";
	}
}

/**
 * Watch the status file and notify the user at each stage.
 * During generation, periodically updates the TUI footer with elapsed time
 * and any error/retry output from pi.
 */
async function watchStatus(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	statusFile: string,
	progressFile: string,
	errorLog: string,
	commitMsgFile: string,
	modelLabel: string,
): Promise<void> {
	let lastStatus: CommitStatus | "" = "";
	const startTime = Date.now();
	const timeout = 600000; // 10 minutes
	let lastProgressUpdate = 0;

	while (Date.now() - startTime < timeout) {
		let status: CommitStatus | "" = "";
		try {
			status = (await fs.readFile(statusFile, "utf-8")).trim() as CommitStatus;
		} catch {
			// Status file doesn't exist yet (script hasn't started)
		}

		if (status && status !== lastStatus) {
			lastStatus = status;

			switch (status) {
				case "generating":
					ctx.ui.notify(`🤖 Generating commit message (${modelLabel})...`, "info");
					ctx.ui.setStatus("commit", `🤖 Commit: generating with ${modelLabel}...`);
					ctx.ui.setWorkingIndicator({
						frames: [
							ctx.ui.theme.fg("dim", "⠋ commit"),
							ctx.ui.theme.fg("muted", "⠙ commit"),
							ctx.ui.theme.fg("accent", "⠹ commit"),
							ctx.ui.theme.fg("muted", "⠸ commit"),
						],
						intervalMs: 120,
					});
					break;
				case "editing":
					ctx.ui.setStatus("commit", undefined); // Clear footer
					ctx.ui.setWorkingIndicator(); // Restore default indicator
					ctx.ui.notify("📝 Review commit message in editor", "info");
					break;
				case "committed": {
					ctx.ui.setStatus("commit", undefined);
					ctx.ui.setWorkingIndicator(); // Restore default indicator
					try {
						const msg = await fs.readFile(commitMsgFile, "utf-8");
						const firstLine = msg.trim().split("\n")[0];
						ctx.ui.notify(`✅ Committed: ${firstLine}`, "success");
						// Get the short hash from git
						const hashResult = await pi.exec("git", ["rev-parse", "--short", "HEAD"], { timeout: 5000 });
						const hash = hashResult.code === 0 ? hashResult.stdout.trim() : "??";
						pi.appendEntry("commit", { hash, message: firstLine });
					} catch {
						ctx.ui.notify("✅ Committed successfully!", "success");
						pi.appendEntry("commit", { hash: "?", message: "committed" });
					}
					break;
				}
				case "retrying": {
					ctx.ui.setWorkingIndicator(); // Restore default indicator
					// Read the retry error for display
					let retryError = "";
					try {
						const retryErrFile = path.join(path.dirname(commitMsgFile), "retry-error");
						const errContent = await fs.readFile(retryErrFile, "utf-8");
						const lastLines = errContent.trim().split("\n").slice(-3);
						retryError = lastLines.join(" | ").substring(0, 100);
					} catch { /* ignore */ }
					const label = retryError ? `⚠ Commit hook failed — waiting in retry loop: ${retryError}` : "⚠ Commit hook failed — waiting in retry loop";
					ctx.ui.setStatus("commit", label);
					ctx.ui.notify("⚠ Commit hook failed. Use [R]etry/[E]dit/[A]bort in the commit pane.", "warn");
					break;
				}
				case "aborted":
					ctx.ui.setStatus("commit", undefined);
					ctx.ui.setWorkingIndicator(); // Restore default indicator
					ctx.ui.notify("🚫 Commit aborted: empty message", "warn");
					break;
				case "failed":
					ctx.ui.setStatus("commit", undefined);
					ctx.ui.setWorkingIndicator(); // Restore default indicator
					ctx.ui.notify("❌ Commit failed", "error");
					break;
				case "closed":
					ctx.ui.setStatus("commit", undefined);
					ctx.ui.setWorkingIndicator(); // Restore default indicator
					await fs.rm(statusFile, { force: true }).catch(() => {});
					return;
			}
		}

		// During generation: update footer with progress every 3 seconds
		if (status === "generating" && Date.now() - lastProgressUpdate > 3000) {
			lastProgressUpdate = Date.now();
			let elapsed = 0;
			try {
				elapsed = parseInt(await fs.readFile(progressFile, "utf-8"), 10) || 0;
			} catch {
				// progress file not written yet
			}

			const lastErr = await readLastError(errorLog);
			const duration = formatDuration(elapsed);

			if (lastErr) {
				ctx.ui.setStatus("commit", `🤖 Commit: ${duration} — ${lastErr}`);
			} else {
				ctx.ui.setStatus("commit", `🤖 Commit: generating with ${modelLabel}... ${duration}`);
			}
		}

		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	ctx.ui.setStatus("commit", undefined);
	ctx.ui.notify("Commit workflow timed out (10 min)", "warn");
	ctx.ui.notify(`Commit message preserved at: ${commitMsgFile}`, "info");
}
