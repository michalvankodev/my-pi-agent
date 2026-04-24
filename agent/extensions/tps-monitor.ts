/**
 * TPS Monitor — shows live output tokens/s while the assistant is streaming.
 *
 * Only counts time during active text_delta output (excludes thinking,
 * tool execution, and idle gaps). Shows last message stats in powerline
 * after streaming ends.
 *
 * During streaming: "Working... (42.3 tok/s, ~1.2k in 28.3s)"
 * Powerline status: "42.3 tok/s · 1.2k out" (persists until next message)
 *
 * Commands: /tps [on|off]
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CHARS_PER_TOKEN = 4;
const THROTTLE_MS = 150;
const MIN_MS = 200;

interface Msg {
	active: boolean;
	windowStart: number;
	totalMs: number;
	chars: number;
}

function fmtTps(n: number): string {
	return n < 10 ? n.toFixed(1) : String(Math.round(n));
}
function fmtTok(n: number): string {
	if (n < 1000) return String(n);
	if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}
function fmtDur(ms: number): string {
	const s = ms / 1000;
	return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.floor(s % 60)}s`;
}

interface LastStats {
	output: number;
	ms: number;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let msg: Msg = { active: false, windowStart: 0, totalMs: 0, chars: 0 };
	let lastThrottle = 0;
	let lastStats: LastStats | null = null;

	const close = () => {
		if (msg.active) {
			msg.totalMs += performance.now() - msg.windowStart;
			msg.active = false;
		}
	};
	const elapsed = () =>
		msg.totalMs + (msg.active ? performance.now() - msg.windowStart : 0);

	pi.on("message_start", async (_event, ctx) => {
		msg = { active: false, windowStart: 0, totalMs: 0, chars: 0 };
		lastThrottle = 0;
		// Clear previous stats when a new message begins
		lastStats = null;
		ctx.ui.setStatus("tps", undefined);
	});

	pi.on("message_update", async (event, ctx) => {
		if (!enabled) return;
		const ev = event.assistantMessageEvent;

		if (ev.type === "text_delta") {
			if (!msg.active) {
				msg.active = true;
				msg.windowStart = performance.now();
			}
			msg.chars += ev.delta.length;

			const now = performance.now();
			if (now - lastThrottle >= THROTTLE_MS) {
				lastThrottle = now;
				const ms = elapsed();
				if (ms >= MIN_MS) {
					const estTok = Math.ceil(msg.chars / CHARS_PER_TOKEN);
					const tps = (estTok / ms) * 1000;
					ctx.ui.setWorkingMessage(
						`Working... (${fmtTps(tps)} tok/s, ~${fmtTok(estTok)} in ${fmtDur(ms)})`,
					);
				}
			}
		} else if (ev.type === "toolcall_delta" || ev.type === "thinking_delta") {
			close();
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (!enabled) return;
		close();

		const output = event.message?.usage?.output;
		if (!output || !msg.chars || msg.totalMs < MIN_MS) return;

		lastStats = { output, ms: msg.totalMs };
		const tps = (output / msg.totalMs) * 1000;
		ctx.ui.setStatus(
			"tps",
			ctx.ui.theme.fg("dim", `${fmtTps(tps)} tok/s · ${fmtTok(output)} out`),
		);
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (enabled) ctx.ui.setWorkingMessage(undefined);
	});

	pi.on("session_start", async (_event, ctx) => {
		lastStats = null;
		ctx.ui.setStatus("tps", undefined);
	});

	pi.registerCommand("tps", {
		description: "Toggle TPS monitor on/off",
		handler: async (args, ctx) => {
			const cmd = args?.trim().toLowerCase();
			if (cmd === "on") {
				enabled = true;
			} else if (cmd === "off") {
				enabled = false;
			} else {
				enabled = !enabled;
			}
			ctx.ui.notify(enabled ? "TPS on" : "TPS off", "info");
		},
	});
}
