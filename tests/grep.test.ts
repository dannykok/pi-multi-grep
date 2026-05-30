import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	buildRipgrepArgs,
	executeGrep,
	formatGlobSummary,
	formatGrepCall,
	formatPathSummary,
	normalizeGlobPatterns,
	normalizeSearchPathInputs,
	prepareGrepArguments,
} from "../src/index.ts";

async function withFixture(files: Record<string, string>, run: (dir: string) => Promise<void>) {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-multi-grep-"));
	try {
		for (const [name, content] of Object.entries(files)) {
			const filePath = path.join(dir, name);
			await mkdir(path.dirname(filePath), { recursive: true });
			await writeFile(filePath, content, "utf8");
		}
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function outputText(result: Awaited<ReturnType<typeof executeGrep>>) {
	return result.content.map((item) => item.text).join("\n");
}

test("normalizes multiple paths while ignoring empty strings", () => {
	assert.deepEqual(normalizeSearchPathInputs(["", "src", "packages", "docs"]), ["src", "packages", "docs"]);
	assert.deepEqual(normalizeSearchPathInputs([]), ["."]);
	assert.deepEqual(normalizeSearchPathInputs(undefined), ["."]);
});

test("summarizes search paths compactly for rendering", () => {
	assert.equal(formatPathSummary(undefined), ".");
	assert.equal(formatPathSummary(["src", "packages", "docs"]), "src, packages, docs");
	assert.equal(formatPathSummary(["src", "packages", "docs", "tests"]), "src, packages, docs, +1 more");
});

test("normalizes multiple globs while ignoring empty strings", () => {
	assert.deepEqual(normalizeGlobPatterns(["", "*.ts", "*.tsx", "!*.test.tsx"]), ["*.ts", "*.tsx", "!*.test.tsx"]);
	assert.deepEqual(normalizeGlobPatterns([]), []);
	assert.deepEqual(normalizeGlobPatterns(undefined), []);
});

test("summarizes glob patterns compactly for rendering", () => {
	assert.equal(formatGlobSummary(undefined), undefined);
	assert.equal(formatGlobSummary(["*.ts", "*.tsx", "!*.test.ts"]), "*.ts, *.tsx, !*.test.ts");
	assert.equal(formatGlobSummary(["*.ts", "*.tsx", "*.svelte", "!*.test.ts"]), "*.ts, *.tsx, *.svelte, +1 more");
});

test("prepareArguments converts legacy path string into paths", () => {
	assert.deepEqual(prepareGrepArguments({ pattern: "MATCH_ME", path: "src", paths: ["packages"] }), {
		pattern: "MATCH_ME",
		paths: ["src", "packages"],
	});
});

test("prepareArguments converts legacy path arrays into paths", () => {
	assert.deepEqual(prepareGrepArguments({ pattern: "MATCH_ME", path: ["src", "packages"], paths: ["docs"] }), {
		pattern: "MATCH_ME",
		paths: ["src", "packages", "docs"],
	});
});

test("prepareArguments converts legacy glob string into globs", () => {
	assert.deepEqual(prepareGrepArguments({ pattern: "MATCH_ME", glob: "*.ts", globs: ["*.tsx"] }), {
		pattern: "MATCH_ME",
		globs: ["*.ts", "*.tsx"],
	});
});

test("prepareArguments converts legacy glob arrays into globs", () => {
	assert.deepEqual(prepareGrepArguments({ pattern: "MATCH_ME", glob: ["*.ts", "*.tsx"], globs: ["!*.test.ts"] }), {
		pattern: "MATCH_ME",
		globs: ["*.ts", "*.tsx", "!*.test.ts"],
	});
});

test("rendering displays multiple glob patterns", () => {
	const theme = {
		bold: (text: string) => text,
		fg: (_name: string, text: string) => text,
	};

	assert.equal(formatGrepCall({ pattern: "MATCH_ME", globs: ["*.ts", "*.tsx", "!*.test.ts"] }, theme), "grep /MATCH_ME/ in . (*.ts, *.tsx, !*.test.ts)");
});

test("rendering displays multiple paths", () => {
	const theme = {
		bold: (text: string) => text,
		fg: (_name: string, text: string) => text,
	};

	assert.equal(formatGrepCall({ pattern: "MATCH_ME", paths: ["src", "packages"] }, theme), "grep /MATCH_ME/ in src, packages");
});

test("ripgrep arguments use one --glob flag per provided glob in order", () => {
	assert.deepEqual(buildRipgrepArgs({ pattern: "TODO", globs: ["*.ts", "*.tsx", "!*.test.tsx"] }, "/repo"), [
		"--json",
		"--line-number",
		"--color=never",
		"--hidden",
		"--glob",
		"*.ts",
		"--glob",
		"*.tsx",
		"--glob",
		"!*.test.tsx",
		"--",
		"TODO",
		"/repo",
	]);
});

test("ripgrep arguments use one positional argument per provided search path in order", () => {
	assert.deepEqual(buildRipgrepArgs({ pattern: "TODO", paths: ["src", "packages", "docs"] }, ["/repo/src", "/repo/packages", "/repo/docs"]), [
		"--json",
		"--line-number",
		"--color=never",
		"--hidden",
		"--",
		"TODO",
		"/repo/src",
		"/repo/packages",
		"/repo/docs",
	]);
});

test("single-element globs still filter matches", async () => {
	await withFixture(
		{
			"a.ts": "MATCH_ME\n",
			"b.js": "MATCH_ME\n",
		},
		async (dir) => {
			const text = outputText(await executeGrep({ pattern: "MATCH_ME", paths: [dir], globs: ["*.ts"] }, { cwd: dir }));
			assert.match(text, /a\.ts:1: MATCH_ME/);
			assert.doesNotMatch(text, /b\.js/);
		},
	);
});

test("multiple include globs search each matching file type", async () => {
	await withFixture(
		{
			"a.ts": "MATCH_ME\n",
			"b.tsx": "MATCH_ME\n",
			"c.js": "MATCH_ME\n",
		},
		async (dir) => {
			const text = outputText(await executeGrep({ pattern: "MATCH_ME", paths: [dir], globs: ["*.ts", "*.tsx"] }, { cwd: dir }));
			assert.match(text, /a\.ts:1: MATCH_ME/);
			assert.match(text, /b\.tsx:1: MATCH_ME/);
			assert.doesNotMatch(text, /c\.js/);
		},
	);
});

test("include and exclude globs use ripgrep semantics", async () => {
	await withFixture(
		{
			"a.ts": "MATCH_ME\n",
			"a.test.ts": "MATCH_ME\n",
			"b.tsx": "MATCH_ME\n",
			"b.test.tsx": "MATCH_ME\n",
		},
		async (dir) => {
			const text = outputText(
				await executeGrep(
					{ pattern: "MATCH_ME", paths: [dir], globs: ["*.ts", "*.tsx", "!*.test.ts", "!*.test.tsx"] },
					{ cwd: dir },
				),
			);
			assert.match(text, /a\.ts:1: MATCH_ME/);
			assert.match(text, /b\.tsx:1: MATCH_ME/);
			assert.doesNotMatch(text, /a\.test\.ts/);
			assert.doesNotMatch(text, /b\.test\.tsx/);
		},
	);
});

test("multiple search paths search each target", async () => {
	await withFixture(
		{
			"src/a.ts": "MATCH_ME\n",
			"packages/pkg-a/b.ts": "MATCH_ME\n",
			"docs/c.ts": "MATCH_ME\n",
		},
		async (dir) => {
			const text = outputText(await executeGrep({ pattern: "MATCH_ME", paths: ["src", "packages"], globs: ["*.ts"] }, { cwd: dir }));
			assert.match(text, /src\/a\.ts:1: MATCH_ME/);
			assert.match(text, /packages\/pkg-a\/b\.ts:1: MATCH_ME/);
			assert.doesNotMatch(text, /docs\/c\.ts/);
		},
	);
});

test("single search path in paths works", async () => {
	await withFixture(
		{
			"src/a.ts": "MATCH_ME\n",
			"packages/pkg-a/b.ts": "MATCH_ME\n",
			"docs/c.ts": "MATCH_ME\n",
		},
		async (dir) => {
			const text = outputText(await executeGrep({ pattern: "MATCH_ME", paths: ["src"], globs: ["*.ts"] }, { cwd: dir }));
			assert.match(text, /a\.ts:1: MATCH_ME/);
			assert.doesNotMatch(text, /packages\/pkg-a\/b\.ts/);
			assert.doesNotMatch(text, /docs\/c\.ts/);
		},
	);
});

test("empty glob strings are ignored", async () => {
	await withFixture(
		{
			"a.ts": "MATCH_ME\n",
			"b.js": "MATCH_ME\n",
		},
		async (dir) => {
			const text = outputText(await executeGrep({ pattern: "MATCH_ME", paths: [dir], globs: ["", "*.ts"] }, { cwd: dir }));
			assert.match(text, /a\.ts:1: MATCH_ME/);
			assert.doesNotMatch(text, /b\.js/);
		},
	);
});
