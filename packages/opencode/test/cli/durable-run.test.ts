import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildAllowedEnvironment,
	createDurableUnitName,
} from "../../src/cli/cmd/durable-run";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("durable-run", () => {
	test("creates unique sanitized unit names with the requested prefix", () => {
		const first = createDurableUnitName("Host.Name With Spaces");
		const second = createDurableUnitName("Host.Name With Spaces");

		expect(first).toMatch(
			/^oc-durable-host-name-with-spaces-[a-z0-9]+-[a-z0-9]+$/,
		);
		expect(second).toMatch(
			/^oc-durable-host-name-with-spaces-[a-z0-9]+-[a-z0-9]+$/,
		);
		expect(first).not.toBe(second);
	});

	test("allows standard variables and explicit additions without leaking other variables", () => {
		const environment = buildAllowedEnvironment(
			{
				PATH: "/usr/bin",
				HOME: "/home/test",
				LANG: "C.UTF-8",
				LC_TIME: "C",
				TERM: "xterm",
				USER: "test",
				SHELL: "/bin/sh",
				SECRET_TOKEN: "do-not-copy",
			},
			["CUSTOM=value", "PATH=/custom/bin"],
		);

		expect(environment).toEqual([
			"CUSTOM=value",
			"HOME=/home/test",
			"LANG=C.UTF-8",
			"LC_TIME=C",
			"PATH=/custom/bin",
			"SHELL=/bin/sh",
			"TERM=xterm",
			"USER=test",
		]);
		expect(
			environment.every((entry) => !entry.startsWith("SECRET_TOKEN=")),
		).toBe(true);
	});

	test("fails actionably before launch when the user manager is unavailable", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "oc-durable-test-"));
		roots.push(root);
		const systemctl = path.join(root, "systemctl");
		const calls = path.join(root, "calls");
		await writeFile(
			systemctl,
			`#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS_FILE"\necho offline\nexit 1\n`,
		);
		await chmod(systemctl, 0o755);

		const proc = Bun.spawn(
			[
				"bun",
				"run",
				"--conditions=browser",
				"./src/index.ts",
				"durable-run",
				"--working-directory",
				root,
				"--",
				"sleep",
				"1",
			],
			{
				cwd: path.join(import.meta.dir, "../.."),
				env: {
					...process.env,
					PATH: `${root}:${process.env.PATH}`,
					CALLS_FILE: calls,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stderr).text(),
		]);

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("systemd user manager is unavailable");
		expect(stderr).toContain("systemctl --user status");
		expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
			"--user is-system-running",
		]);
	});
});
