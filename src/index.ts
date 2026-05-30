import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import type { ExtensionAPI, GrepToolDetails } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize, keyHint, truncateHead, truncateLine } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const DEFAULT_LIMIT = 100;
const GREP_MAX_LINE_LENGTH = 500;

export const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Directories or files to search (default: current directory). Each entry is passed as a separate ripgrep path argument.",
		}),
	),
	globs: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"File glob filters. Each entry is passed as a separate ripgrep --glob. Supports include patterns like '*.ts' and exclude patterns like '!*.test.ts'.",
		}),
	),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
	context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export type MultiGlobGrepToolInput = Static<typeof grepSchema>;

export interface ExecuteGrepOptions {
	cwd: string;
	signal?: AbortSignal | undefined;
	rgPath?: string | undefined;
}

export type GrepExecutionResult = {
	content: Array<{ type: "text"; text: string }>;
	details: GrepToolDetails | undefined;
};

type Match = {
	filePath: string;
	lineNumber: number;
	lineText?: string;
};

type SearchRoot = {
	rawPath: string;
	searchPath: string;
	isDirectory: boolean;
};

export function normalizeSearchPathInputs(searchPaths?: readonly string[]): string[] {
	const paths = (searchPaths ?? []).filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return paths.length > 0 ? paths : ["."];
}

export function formatPathSummary(searchPaths?: readonly string[]): string {
	const paths = normalizeSearchPathInputs(searchPaths);
	const displayPaths = paths.map((entry) => shortenPath(entry));
	if (displayPaths.length <= 3) return displayPaths.join(", ");
	return `${displayPaths.slice(0, 3).join(", ")}, +${displayPaths.length - 3} more`;
}

export function normalizeGlobPatterns(globs?: readonly string[]): string[] {
	return (globs ?? []).filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export function formatGlobSummary(globs?: readonly string[]): string | undefined {
	const patterns = normalizeGlobPatterns(globs);
	if (patterns.length === 0) return undefined;
	if (patterns.length <= 3) return patterns.join(", ");
	return `${patterns.slice(0, 3).join(", ")}, +${patterns.length - 3} more`;
}

export function prepareGrepArguments(args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;

	const input = args as Record<string, unknown>;
	let next: Record<string, unknown> | undefined;

	const legacyPaths = legacyStringOrArray(input.path);
	if (legacyPaths) {
		const { path: _path, ...rest } = input;
		const existingPaths = Array.isArray(input.paths) ? input.paths : [];
		next = {
			...rest,
			paths: [...legacyPaths, ...existingPaths],
		};
	}

	const current = next ?? input;
	const legacyGlobs = legacyStringOrArray(current.glob);
	if (legacyGlobs) {
		const { glob: _glob, ...rest } = current;
		const existingGlobs = Array.isArray(current.globs) ? current.globs : [];
		next = {
			...rest,
			globs: [...legacyGlobs, ...existingGlobs],
		};
	}

	return next ?? args;
}

function legacyStringOrArray(value: unknown): unknown[] | undefined {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value;
	return undefined;
}

export function buildRipgrepArgs(input: MultiGlobGrepToolInput, searchPaths: string | readonly string[]): string[] {
	const args = ["--json", "--line-number", "--color=never", "--hidden"];

	if (input.ignoreCase) args.push("--ignore-case");
	if (input.literal) args.push("--fixed-strings");

	for (const globPattern of normalizeGlobPatterns(input.globs)) {
		args.push("--glob", globPattern);
	}

	const searchPathArgs = Array.isArray(searchPaths) ? searchPaths : [searchPaths];
	args.push("--", input.pattern, ...searchPathArgs);
	return args;
}

export async function executeGrep(input: MultiGlobGrepToolInput, options: ExecuteGrepOptions): Promise<GrepExecutionResult> {
	const { cwd, signal, rgPath = "rg" } = options;

	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}

	const rawSearchPaths = normalizeSearchPathInputs(input.paths);
	const searchRoots = await Promise.all(
		rawSearchPaths.map(async (rawPath): Promise<SearchRoot> => {
			const searchPath = resolveToCwd(rawPath, cwd);
			const searchStat = await stat(searchPath).catch(() => undefined);
			if (!searchStat) {
				throw new Error(`Path not found: ${searchPath}`);
			}

			return { rawPath, searchPath, isDirectory: searchStat.isDirectory() };
		}),
	);

	const contextValue = typeof input.context === "number" && input.context > 0 ? Math.floor(input.context) : 0;
	const effectiveLimit = Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT));
	const args = buildRipgrepArgs(
		input,
		searchRoots.map((root) => root.searchPath),
	);

	return new Promise<GrepExecutionResult>((resolve, reject) => {
		let settled = false;
		let aborted = false;
		let killedDueToLimit = false;
		let stderr = "";
		let matchCount = 0;
		let matchLimitReached = false;
		let linesTruncated = false;
		const matches: Match[] = [];
		const outputLines: string[] = [];
		const fileCache = new Map<string, string[]>();

		const settle = (fn: () => void) => {
			if (!settled) {
				settled = true;
				fn();
			}
		};

		const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });

		function cleanup() {
			rl.close();
			signal?.removeEventListener("abort", onAbort);
		}

		function stopChild(dueToLimit = false) {
			if (!child.killed) {
				killedDueToLimit = dueToLimit;
				child.kill();
			}
		}

		function onAbort() {
			aborted = true;
			stopChild();
		}

		const formatPath = createPathFormatter(searchRoots, cwd);

		const getFileLines = async (filePath: string) => {
			let lines = fileCache.get(filePath);
			if (!lines) {
				try {
					const content = await readFile(filePath, "utf8");
					lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
				} catch {
					lines = [];
				}
				fileCache.set(filePath, lines);
			}
			return lines;
		};

		const formatBlock = async (filePath: string, lineNumber: number) => {
			const relativePath = formatPath(filePath);
			const lines = await getFileLines(filePath);
			if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];

			const block: string[] = [];
			const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
			const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;

			for (let current = start; current <= end; current++) {
				const lineText = lines[current - 1] ?? "";
				const sanitized = lineText.replace(/\r/g, "");
				const isMatchLine = current === lineNumber;
				const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
				if (wasTruncated) linesTruncated = true;

				if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
				else block.push(`${relativePath}-${current}- ${truncatedText}`);
			}

			return block;
		};

		signal?.addEventListener("abort", onAbort, { once: true });

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		rl.on("line", (line) => {
			if (!line.trim() || matchCount >= effectiveLimit) return;

			const match = parseRipgrepMatch(line);
			if (!match) return;

			matchCount++;
			matches.push(match);

			if (matchCount >= effectiveLimit) {
				matchLimitReached = true;
				stopChild(true);
			}
		});

		child.on("error", (error: NodeJS.ErrnoException) => {
			cleanup();
			const message =
				error.code === "ENOENT"
					? "ripgrep (rg) is not available. Install ripgrep or ensure rg is on PATH."
					: `Failed to run ripgrep: ${error.message}`;
			settle(() => reject(new Error(message)));
		});

		child.on("close", (code) => {
			void (async () => {
				cleanup();

				if (aborted) {
					settle(() => reject(new Error("Operation aborted")));
					return;
				}

				if (!killedDueToLimit && code !== 0 && code !== 1) {
					const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
					settle(() => reject(new Error(errorMsg)));
					return;
				}

				if (matchCount === 0) {
					settle(() => resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }));
					return;
				}

				for (const match of matches) {
					if (contextValue === 0 && match.lineText !== undefined) {
						const relativePath = formatPath(match.filePath);
						const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
						const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
						if (wasTruncated) linesTruncated = true;
						outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
					} else {
						const block = await formatBlock(match.filePath, match.lineNumber);
						outputLines.push(...block);
					}
				}

				const rawOutput = outputLines.join("\n");
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
				let output = truncation.content;
				const details: GrepToolDetails = {};
				const notices: string[] = [];

				if (matchLimitReached) {
					notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
					details.matchLimitReached = effectiveLimit;
				}

				if (truncation.truncated) {
					notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
					details.truncation = truncation;
				}

				if (linesTruncated) {
					notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
					details.linesTruncated = true;
				}

				if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

				settle(() =>
					resolve({
						content: [{ type: "text", text: output }],
						details: Object.keys(details).length > 0 ? details : undefined,
					}),
				);
			})().catch((error: unknown) => {
				settle(() => reject(error instanceof Error ? error : new Error(String(error))));
			});
		});
	});
}

function createPathFormatter(searchRoots: readonly SearchRoot[], cwd: string): (filePath: string) => string {
	if (searchRoots.length === 1) {
		const root = searchRoots[0]!;
		return (filePath: string) => {
			if (root.isDirectory) {
				const relative = relativeInside(root.searchPath, filePath);
				if (relative) return relative;
			}

			return path.basename(filePath);
		};
	}

	return (filePath: string) => {
		const relativeToCwd = relativeInside(cwd, filePath);
		if (relativeToCwd) return relativeToCwd;

		for (const root of searchRoots) {
			if (root.isDirectory) {
				const relative = relativeInside(root.searchPath, filePath);
				if (relative) {
					const rootLabel = searchRootDisplayLabel(root, cwd);
					return rootLabel === "." ? relative : normalizeDisplayPath(path.join(rootLabel, relative));
				}
			} else if (path.resolve(filePath) === root.searchPath) {
				return searchRootDisplayLabel(root, cwd);
			}
		}

		return path.basename(filePath);
	};
}

function relativeInside(rootPath: string, targetPath: string): string | undefined {
	const relative = path.relative(rootPath, targetPath);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return normalizeDisplayPath(relative);
}

function searchRootDisplayLabel(root: SearchRoot, cwd: string): string {
	const rawPath = root.rawPath.startsWith("@") ? root.rawPath.slice(1) : root.rawPath;
	if (!path.isAbsolute(rawPath)) return normalizeDisplayPath(rawPath || ".");

	const relativeToCwd = relativeInside(cwd, root.searchPath);
	if (relativeToCwd) return relativeToCwd;

	return path.basename(root.searchPath);
}

function normalizeDisplayPath(displayPath: string): string {
	return displayPath.replace(/\\/g, "/");
}

function parseRipgrepMatch(line: string): Match | undefined {
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return undefined;
	}

	if (!isRecord(event) || event.type !== "match" || !isRecord(event.data)) return undefined;

	const pathData = event.data.path;
	const linesData = event.data.lines;
	const filePath = isRecord(pathData) && typeof pathData.text === "string" ? pathData.text : undefined;
	const lineNumber = typeof event.data.line_number === "number" ? event.data.line_number : undefined;
	const lineText = isRecord(linesData) && typeof linesData.text === "string" ? linesData.text : undefined;

	if (!filePath || lineNumber === undefined) return undefined;
	return lineText === undefined ? { filePath, lineNumber } : { filePath, lineNumber, lineText };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveToCwd(rawPath: string, cwd: string): string {
	const withoutAtPrefix = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	return path.isAbsolute(withoutAtPrefix) ? withoutAtPrefix : path.resolve(cwd, withoutAtPrefix);
}

function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function stringArray(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
	return [];
}

function shortenPath(displayPath: string): string {
	const home = homedir();
	return displayPath.startsWith(home) ? `~${displayPath.slice(home.length)}` : displayPath;
}

function textOutput(result: { content?: Array<{ type?: string; text?: string }> } | undefined): string {
	return (result?.content ?? [])
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text.replace(/\r/g, ""))
		.join("\n");
}

export function formatGrepCall(args: unknown, theme: any): string {
	const input = isRecord(args) ? args : undefined;
	const pattern = str(input?.pattern);
	const paths = [...stringArray(input?.path), ...stringArray(input?.paths)];
	const displayPath = formatPathSummary(paths);
	const globs = [...stringArray(input?.glob), ...stringArray(input?.globs)];
	const globSummary = formatGlobSummary(globs);
	const limit = input?.limit;
	const invalidArg = theme.fg("error", "[invalid arg]");

	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${displayPath === null ? invalidArg : displayPath}`);

	if (globSummary) text += theme.fg("toolOutput", ` (${globSummary})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${String(limit)}`);
	return text;
}

function formatGrepResult(
	result: { content?: Array<{ type?: string; text?: string }>; details?: GrepToolDetails } | undefined,
	options: { expanded?: boolean },
	theme: any,
): string {
	const output = textOutput(result).trim();
	let text = "";

	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;

		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	const matchLimit = result?.details?.matchLimitReached;
	const truncation = result?.details?.truncation;
	const linesTruncated = result?.details?.linesTruncated;

	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}

	return text;
}

export default function multiGlobGrepExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Supports paths for one or more search targets and globs for one or more include/exclude patterns. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: "Search file contents for patterns (respects .gitignore; supports paths/globs filters)",
		promptGuidelines: [
			"Use grep with paths and globs when searches need multiple search targets or multiple include/exclude file patterns instead of falling back to bash/rg.",
		],
		parameters: grepSchema,
		prepareArguments(args) {
			return prepareGrepArguments(args) as MultiGlobGrepToolInput;
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeGrep(params, { cwd: ctx.cwd, signal });
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme));
			return text;
		},

		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result as { content?: Array<{ type?: string; text?: string }>; details?: GrepToolDetails }, options, theme));
			return text;
		},
	});
}
