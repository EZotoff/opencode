import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Argv } from "yargs";

type DurableRunArgs = {
	readonly "--"?: readonly string[];
	readonly workingDirectory?: string;
	readonly env?: readonly string[];
	readonly property?: readonly string[];
	readonly logFile?: string;
	readonly stop?: string;
	readonly status?: string;
};

type CommandResult = {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
};

const UNIT_PATTERN = /^oc-durable-[a-z0-9][a-z0-9-]{0,127}$/;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROPERTY_PATTERN = /^[A-Za-z][A-Za-z0-9]*=.+$/;
const ALLOWED_ENVIRONMENT =
	/^(?:PATH|HOME|LANG|TERM|USER|SHELL|LC_[A-Za-z0-9_]+)$/;

export class DurableRunError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DurableRunError";
	}
}

export function createDurableUnitName(prefix: string): string {
	const sanitized = prefix
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	const safePrefix = sanitized || "host";
	const timestamp = Date.now().toString(36);
	const random = randomBytes(6).toString("hex");
	const unit = `oc-durable-${safePrefix}-${timestamp}-${random}`;
	if (!UNIT_PATTERN.test(unit))
		throw new DurableRunError(
			"Could not generate a valid durable-run unit name",
		);
	return unit;
}

export function buildAllowedEnvironment(
	source: Readonly<Record<string, string | undefined>>,
	additions: readonly string[],
): readonly string[] {
	const environment = new Map<string, string>();
	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined && ALLOWED_ENVIRONMENT.test(key))
			environment.set(key, value);
	}
	for (const assignment of additions) {
		const separator = assignment.indexOf("=");
		const key = separator < 0 ? "" : assignment.slice(0, separator);
		if (!ENVIRONMENT_KEY_PATTERN.test(key)) {
			throw new DurableRunError(
				`Invalid --env key '${key || assignment}'; expected KEY=VALUE`,
			);
		}
		environment.set(key, assignment.slice(separator + 1));
	}
	return [...environment.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}=${value}`);
}

async function run(command: readonly string[]): Promise<CommandResult> {
	const proc = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function validateUnit(unit: string): string {
	if (!UNIT_PATTERN.test(unit)) {
		throw new DurableRunError(
			"Unit must be an oc-durable-* unit created by this command",
		);
	}
	return unit;
}

async function ensureManager(): Promise<void> {
	const result = await run(["systemctl", "--user", "is-system-running"]);
	if (
		result.exitCode === 0 ||
		result.stdout === "running" ||
		result.stdout === "degraded"
	)
		return;
	throw new DurableRunError(
		"systemd user manager is unavailable. Run 'systemctl --user status'; on a headless host, enable lingering with 'loginctl enable-linger $USER'.",
	);
}

async function cleanup(unit: string): Promise<void> {
	await run(["systemctl", "--user", "stop", unit]);
	await run(["systemctl", "--user", "reset-failed", unit]);
}

async function launch(args: DurableRunArgs): Promise<void> {
	if (!args.workingDirectory)
		throw new DurableRunError("--working-directory is required");
	const directory = path.resolve(args.workingDirectory);
	const info = await stat(directory).catch(() => undefined);
	if (!info?.isDirectory())
		throw new DurableRunError(`Working directory does not exist: ${directory}`);
	const command = args["--"] ?? [];
	if (command.length === 0)
		throw new DurableRunError("Command is required after '--'");
	if (args.logFile && !path.isAbsolute(args.logFile))
		throw new DurableRunError("--log-file must be an absolute path");

	const properties = args.property ?? [];
	for (const property of properties) {
		if (
			!PROPERTY_PATTERN.test(property) ||
			property.startsWith("CollectMode=")
		) {
			throw new DurableRunError(`Invalid --property '${property}'`);
		}
	}

	await ensureManager();
	const unit = createDurableUnitName(
		process.env.OPENCODE_INSTANCE_ID ?? os.hostname(),
	);
	const environment = buildAllowedEnvironment(process.env, args.env ?? []);
	const systemdRun = [
		"systemd-run",
		"--user",
		`--unit=${unit}`,
		`--working-directory=${directory}`,
		"--property=CollectMode=inactive-or-failed",
		...properties.map((property) => `--property=${property}`),
	];
	if (args.logFile) {
		systemdRun.push(`--property=StandardOutput=append:${args.logFile}`);
		systemdRun.push(`--property=StandardError=append:${args.logFile}`);
	}
	systemdRun.push("--", "/usr/bin/env", "-i", ...environment, ...command);

	const launched = await run(systemdRun);
	const active =
		launched.exitCode === 0
			? await run(["systemctl", "--user", "is-active", unit])
			: undefined;
	if (launched.exitCode !== 0 || active?.stdout !== "active") {
		await cleanup(unit);
		const detail =
			launched.stderr ||
			active?.stderr ||
			active?.stdout ||
			"unit did not become active";
		throw new DurableRunError(
			`Failed to start durable unit ${unit}: ${detail}. Check 'systemctl --user status ${unit}'.`,
		);
	}

	console.log(`Started durable unit: ${unit}`);
	console.log(`Logs: journalctl --user -u ${unit} -f`);
	console.log(`Status: systemctl --user status ${unit}`);
	console.log(`Stop: systemctl --user stop ${unit}`);
}

export const DurableRunCommand = {
	command: "durable-run",
	describe: "launch a validated transient systemd user service",
	builder: (yargs: Argv) =>
		yargs
			.option("working-directory", {
				type: "string",
				describe:
					"absolute or relative working directory (required for launch)",
			})
			.option("env", {
				type: "string",
				array: true,
				describe: "add KEY=VALUE to the allowlisted service environment",
			})
			.option("property", {
				type: "string",
				array: true,
				describe: "set a systemd service property, for example MemoryMax=1G",
			})
			.option("log-file", {
				type: "string",
				describe: "absolute log path (default: systemd journal)",
			})
			.option("stop", {
				type: "string",
				describe: "stop an oc-durable-* unit",
			})
			.option("status", {
				type: "string",
				describe: "show status for an oc-durable-* unit",
			})
			.epilog(
				"Fallback without systemd: setsid COMMAND </dev/null >log 2>&1 & is best-effort only and is not supervised.",
			),
	handler: async (args: DurableRunArgs) => {
		if (args.stop && args.status)
			throw new DurableRunError("Choose only one of --stop or --status");
		if (args.stop) {
			await ensureManager();
			const unit = validateUnit(args.stop);
			const result = await run(["systemctl", "--user", "stop", unit]);
			if (result.exitCode !== 0)
				throw new DurableRunError(result.stderr || `Failed to stop ${unit}`);
			await run(["systemctl", "--user", "reset-failed", unit]);
			console.log(`Stopped durable unit: ${unit}`);
			return;
		}
		if (args.status) {
			await ensureManager();
			const unit = validateUnit(args.status);
			const result = await run(["systemctl", "--user", "status", unit]);
			process.stdout.write(result.stdout + (result.stdout ? "\n" : ""));
			if (result.exitCode !== 0)
				throw new DurableRunError(result.stderr || `${unit} is not active`);
			return;
		}
		await launch(args);
	},
};
