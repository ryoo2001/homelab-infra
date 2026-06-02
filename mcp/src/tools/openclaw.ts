import { z } from "zod";
import {
  joinShellCommand,
  jsonText,
  readonlyTool,
  destructiveTool,
  remoteCommandInDir,
  shellQuote
} from "../helpers.js";
import type { Deps } from "./deps.js";
import type { HostConfig } from "../config.js";

const OPENCLAW_MODE = z.enum(["auto", "local", "compose"]).default("auto");
const OPENCLAW_ACTION = z.enum(["install", "start", "stop", "restart", "uninstall"]);
const OPENCLAW_SERVICE = z.string().regex(/^[A-Za-z0-9_.@:-]+$/);
const OPENCLAW_TASK_RUNTIME = z.enum(["subagent", "acp", "cron", "cli"]);
const OPENCLAW_TASK_STATUS = z.enum(["queued", "running", "succeeded", "failed", "timed_out", "cancelled", "lost"]);
const OPENCLAW_TASK_AUDIT_SEVERITY = z.enum(["warn", "error"]);
const OPENCLAW_SECURITY_AUTH = z.enum(["none", "token", "password", "trusted-proxy"]);
const SAFE_ARG = z.string().min(1).max(4096).refine((value) => !value.includes("\0"));
const SAFE_PATH = z.string().min(1).max(4096).refine((value) => !value.includes("\0"));
const SAFE_ENV = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().max(8192).refine((value) => !value.includes("\0"))
);

type OpenClawMode = z.infer<typeof OPENCLAW_MODE>;

type Runner = {
  mode: "local" | "compose";
  cliPath: string;
  composeDir?: string;
  cliService: string;
};

type RunnerOptions = {
  mode?: OpenClawMode;
  cliPath?: string;
  composeDir?: string;
  cliService?: string;
  profile?: string;
  dev?: boolean;
  env?: Record<string, string>;
};

type GatewayClientOptions = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: number;
};

function noNull(value?: string): string | undefined {
  if (value?.includes("\0")) {
    throw new Error("Invalid input: NUL bytes are not allowed.");
  }
  return value;
}

function gatewayHttpBase(gatewayUrl: string): string {
  const normalized = gatewayUrl.replace(/\/+$/, "");
  if (normalized.startsWith("ws://")) {
    return `http://${normalized.slice("ws://".length)}`;
  }
  if (normalized.startsWith("wss://")) {
    return `https://${normalized.slice("wss://".length)}`;
  }
  return normalized;
}

function gatewayPort(gatewayUrl: string): string | null {
  try {
    const parsed = new URL(gatewayUrl);
    if (parsed.port) {
      return parsed.port;
    }
    if (parsed.protocol === "https:" || parsed.protocol === "wss:") {
      return "443";
    }
    if (parsed.protocol === "http:" || parsed.protocol === "ws:") {
      return "80";
    }
    return null;
  } catch {
    return null;
  }
}

function executableExistsCommand(cliPath: string): string {
  const quoted = shellQuote(cliPath);
  return `[ -x ${quoted} ] || command -v ${quoted} >/dev/null 2>&1`;
}

function dockerComposeServiceExistsCommand(composeDir: string, service: string): string {
  return remoteCommandInDir(
    composeDir,
    `docker compose config --services 2>/dev/null | grep -Fx ${shellQuote(service)} >/dev/null`
  );
}

function envAssignments(env?: Record<string, string>): string {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) {
    return "";
  }
  return `${entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")} `;
}

function composeEnvArgs(env?: Record<string, string>): string[] {
  return Object.entries(env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

function globalArgs(options: RunnerOptions): string[] {
  return [
    ...(options.dev ? ["--dev"] : []),
    ...(options.profile ? ["--profile", options.profile] : [])
  ];
}

function appendGatewayClientFlags(args: string[], options: GatewayClientOptions): string[] {
  if (options.url) {
    args.push("--url", noNull(options.url) ?? "");
  }
  if (options.token) {
    args.push("--token", noNull(options.token) ?? "");
  }
  if (options.password) {
    args.push("--password", noNull(options.password) ?? "");
  }
  if (options.timeout) {
    args.push("--timeout", String(options.timeout));
  }
  return args;
}

function buildOpenClawCommand(runner: Runner, options: RunnerOptions, args: string[]): string {
  const fullArgs = [...globalArgs(options), ...args];
  if (runner.mode === "compose") {
    if (!runner.composeDir) {
      throw new Error("OPENCLAW_COMPOSE_DIR or composeDir is required for compose mode.");
    }
    return remoteCommandInDir(
      runner.composeDir,
      joinShellCommand([
        "docker",
        "compose",
        "run",
        "--rm",
        "-T",
        ...composeEnvArgs(options.env),
        runner.cliService,
        ...fullArgs
      ])
    );
  }

  return `${envAssignments(options.env)}${joinShellCommand([runner.cliPath, ...fullArgs])}`;
}

async function resolveRunner(host: HostConfig, { config, ssh }: Pick<Deps, "config" | "ssh">, options: RunnerOptions): Promise<Runner> {
  const mode = options.mode ?? "auto";
  const cliPath = options.cliPath ?? config.openclawCliPath;
  const composeDir = options.composeDir ?? config.openclawComposeDir;
  const cliService = options.cliService ?? config.openclawCliService;

  if (mode === "compose") {
    if (!composeDir) {
      throw new Error("OPENCLAW_COMPOSE_DIR or composeDir is required for compose mode.");
    }
    return { mode: "compose", cliPath, composeDir, cliService };
  }

  if (mode === "local") {
    return { mode: "local", cliPath, cliService };
  }

  if (composeDir) {
    const composeCheck = await ssh.runSsh(
      host,
      dockerComposeServiceExistsCommand(composeDir, cliService),
      10000
    );
    if (composeCheck.code === 0) {
      return { mode: "compose", cliPath, composeDir, cliService };
    }
  }

  const localCheck = await ssh.runSsh(host, executableExistsCommand(cliPath), 10000);
  if (localCheck.code === 0) {
    return { mode: "local", cliPath, cliService };
  }

  throw new Error(
    `OpenClaw was not found on ${host.host}. Configure OPENCLAW_CLI_PATH for a native install or OPENCLAW_COMPOSE_DIR for Docker Compose.`
  );
}

async function runOpenClaw(
  host: HostConfig,
  deps: Pick<Deps, "config" | "ssh">,
  options: RunnerOptions,
  args: string[],
  timeoutMs?: number
) {
  const runner = await resolveRunner(host, deps, options);
  const result = await deps.ssh.runSsh(host, buildOpenClawCommand(runner, options, args), timeoutMs);
  return { runner, result };
}

function parseJson(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringAt(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[key];
  }
  return typeof current === "string" && current ? current : null;
}

function gatewayUrlFromStatus(stdout: string): string | null {
  const parsed = parseJson(stdout);
  const explicit =
    stringAt(parsed, ["gateway", "probeUrl"]) ??
    stringAt(parsed, ["rpc", "url"]);
  if (explicit) {
    return explicit;
  }

  if (!isRecord(parsed) || !isRecord(parsed.gateway)) {
    return null;
  }
  const port = parsed.gateway.port;
  const bindHost = typeof parsed.gateway.bindHost === "string" && parsed.gateway.bindHost
    ? parsed.gateway.bindHost
    : "127.0.0.1";
  if (typeof port === "number" || typeof port === "string") {
    return `ws://${bindHost}:${port}`;
  }
  return null;
}

function resultEnvelope(host: HostConfig, runner: Runner, result: Awaited<ReturnType<Deps["ssh"]["runSsh"]>>) {
  return {
    host: host.host,
    mode: runner.mode,
    ...(runner.composeDir ? { composeDir: runner.composeDir } : {}),
    stdout: result.stdout.trim(),
    json: parseJson(result.stdout),
    stderr: result.stderr.trim(),
    code: result.code,
    ...(result.truncated ? { truncated: true } : {})
  };
}

async function runOpenClawEnvelope(
  host: HostConfig,
  deps: Pick<Deps, "config" | "ssh">,
  options: RunnerOptions,
  args: string[],
  timeoutMs?: number
) {
  const { runner, result } = await runOpenClaw(host, deps, options, args, timeoutMs);
  return resultEnvelope(host, runner, result);
}

function openClawCommonSchema(extra: Record<string, z.ZodTypeAny> = {}): Record<string, z.ZodTypeAny> {
  return {
    hostId: z.string(),
    mode: OPENCLAW_MODE,
    cliPath: SAFE_PATH.optional(),
    composeDir: SAFE_PATH.optional(),
    cliService: OPENCLAW_SERVICE.optional(),
    profile: SAFE_ARG.optional(),
    dev: z.boolean().default(false),
    timeoutMs: z.number().int().positive().max(180000).default(60000),
    ...extra
  };
}

function runnerOptionsFromArgs(args: {
  mode: OpenClawMode;
  cliPath?: string;
  composeDir?: string;
  cliService?: string;
  profile?: string;
  dev?: boolean;
}): RunnerOptions {
  return {
    mode: args.mode,
    cliPath: args.cliPath,
    composeDir: args.composeDir,
    cliService: args.cliService,
    profile: args.profile,
    dev: args.dev
  };
}

export function registerOpenClawTools({ server, config, ssh, assertAllowedHost }: Deps): void {
  readonlyTool(
    server,
    "openclaw_discover",
    "Discover OpenClaw deployment",
    "Discover native CLI, Docker Compose, gateway service, listening ports, and health endpoints for OpenClaw on a managed host.",
    {
      hostId: z.string(),
      cliPath: SAFE_PATH.optional(),
      composeDir: SAFE_PATH.optional(),
      gatewayUrl: z.string().optional()
    },
    async ({ hostId, cliPath, composeDir, gatewayUrl }) => {
      const host = assertAllowedHost(hostId);
      const effectiveCliPath = cliPath ?? config.openclawCliPath;
      const effectiveComposeDir = composeDir ?? config.openclawComposeDir ?? "";
      const batch = await ssh.runBatch(host, [
        {
          name: "cli_path",
          command: `${executableExistsCommand(effectiveCliPath)} && command -v ${shellQuote(effectiveCliPath)} || true`
        },
        {
          name: "cli_version",
          command: `if ${executableExistsCommand(effectiveCliPath)}; then ${joinShellCommand([
            effectiveCliPath,
            "--version"
          ])} 2>&1; fi`
        },
        {
          name: "gateway_status",
          command: `if ${executableExistsCommand(effectiveCliPath)}; then ${joinShellCommand([
            effectiveCliPath,
            "gateway",
            "status",
            "--json",
            "--timeout",
            "5000"
          ])} 2>&1 || true; fi`
        },
        {
          name: "compose_services",
          command: effectiveComposeDir
            ? `if [ -d ${shellQuote(effectiveComposeDir)} ]; then ${remoteCommandInDir(
                effectiveComposeDir,
                "docker compose config --services 2>&1 && docker compose ps --all 2>&1"
              )}; fi`
            : "true"
        },
        {
          name: "docker_containers",
          command:
            "if command -v docker >/dev/null 2>&1; then docker ps -a --format '{{.ID}}|{{.Image}}|{{.Names}}|{{.Status}}|{{.Ports}}' | grep -i openclaw || true; else echo 'docker unavailable'; fi"
        },
        {
          name: "user_services",
          command:
            "systemctl --user list-units --all 'openclaw*.service' --no-legend --no-pager 2>&1 || true"
        },
        {
          name: "system_services",
          command: "systemctl list-units --all 'openclaw*.service' --no-legend --no-pager 2>&1 || true"
        }
      ]);

      const discoveredGatewayUrl = gatewayUrl ?? gatewayUrlFromStatus(batch.outputs.gateway_status) ?? config.openclawGatewayUrl;
      const httpBase = gatewayHttpBase(discoveredGatewayUrl);
      const port = gatewayPort(discoveredGatewayUrl);
      const healthBatch = await ssh.runBatch(host, [
        {
          name: "ports",
          command: `ss -tulpnH 2>/dev/null | grep -Ei ${shellQuote(port ? `(:${port}|openclaw)` : "openclaw")} || true`
        },
        {
          name: "healthz",
          command: `if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 3 ${shellQuote(
            `${httpBase}/healthz`
          )} 2>&1 || true; printf '\\n'; fi`
        },
        {
          name: "readyz",
          command: `if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 3 ${shellQuote(
            `${httpBase}/readyz`
          )} 2>&1 || true; printf '\\n'; fi`
        }
      ]);

      return {
        content: jsonText({
          host: host.host,
          cliPath: effectiveCliPath,
          composeDir: effectiveComposeDir || null,
          configuredGatewayUrl: config.openclawGatewayUrl,
          gatewayUrl: discoveredGatewayUrl,
          cliPathResolved: batch.outputs.cli_path.trim(),
          cliVersion: batch.outputs.cli_version.trim(),
          gatewayStatus: batch.outputs.gateway_status.trim(),
          compose: batch.outputs.compose_services.trim(),
          dockerContainers: batch.outputs.docker_containers.trim(),
          userServices: batch.outputs.user_services.trim(),
          systemServices: batch.outputs.system_services.trim(),
          ports: healthBatch.outputs.ports.trim(),
          healthz: healthBatch.outputs.healthz.trim(),
          readyz: healthBatch.outputs.readyz.trim(),
          stderr: [batch.stderr.trim(), healthBatch.stderr.trim()].filter(Boolean).join("\n"),
          code: batch.code === 0 ? healthBatch.code : batch.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_status",
    "Get OpenClaw status",
    "Return OpenClaw version, gateway status, overall status, and optional doctor lint output.",
    {
      hostId: z.string(),
      mode: OPENCLAW_MODE,
      cliPath: SAFE_PATH.optional(),
      composeDir: SAFE_PATH.optional(),
      cliService: OPENCLAW_SERVICE.optional(),
      profile: SAFE_ARG.optional(),
      dev: z.boolean().default(false),
      includeDoctor: z.boolean().default(false),
      timeoutMs: z.number().int().positive().max(120000).default(30000)
    },
    async ({ hostId, mode, cliPath, composeDir, cliService, profile, dev, includeDoctor, timeoutMs }) => {
      const host = assertAllowedHost(hostId);
      const options = { mode, cliPath, composeDir, cliService, profile, dev };
      const version = await runOpenClaw(host, { config, ssh }, options, ["--version"], timeoutMs);
      const gateway = await runOpenClaw(
        host,
        { config, ssh },
        options,
        ["gateway", "status", "--json", "--timeout", "10000"],
        timeoutMs
      );
      const status = await runOpenClaw(host, { config, ssh }, options, ["status", "--json"], timeoutMs);
      const doctor = includeDoctor
        ? await runOpenClaw(host, { config, ssh }, options, ["doctor", "--lint", "--json"], timeoutMs)
        : null;

      return {
        content: jsonText({
          host: host.host,
          mode: version.runner.mode,
          version: resultEnvelope(host, version.runner, version.result),
          gateway: resultEnvelope(host, gateway.runner, gateway.result),
          status: resultEnvelope(host, status.runner, status.result),
          doctor: doctor ? resultEnvelope(host, doctor.runner, doctor.result) : null
        })
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_gateway_probe",
    "Probe OpenClaw gateway",
    "Run `openclaw gateway probe --json` through the native CLI or Docker Compose CLI sidecar.",
    {
      hostId: z.string(),
      mode: OPENCLAW_MODE,
      cliPath: SAFE_PATH.optional(),
      composeDir: SAFE_PATH.optional(),
      cliService: OPENCLAW_SERVICE.optional(),
      profile: SAFE_ARG.optional(),
      dev: z.boolean().default(false),
      url: z.string().optional(),
      token: z.string().optional(),
      password: z.string().optional(),
      timeout: z.number().int().positive().max(120000).default(10000)
    },
    async ({ hostId, mode, cliPath, composeDir, cliService, profile, dev, url, token, password, timeout }) => {
      const host = assertAllowedHost(hostId);
      const args = appendGatewayClientFlags(["gateway", "probe", "--json"], {
        url,
        token,
        password,
        timeout
      });
      const { runner, result } = await runOpenClaw(
        host,
        { config, ssh },
        { mode, cliPath, composeDir, cliService, profile, dev },
        args,
        timeout + 5000
      );
      return {
        content: jsonText(resultEnvelope(host, runner, result))
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_logs",
    "Fetch OpenClaw logs",
    "Fetch recent OpenClaw gateway logs via `openclaw logs` without following indefinitely.",
    {
      hostId: z.string(),
      mode: OPENCLAW_MODE,
      cliPath: SAFE_PATH.optional(),
      composeDir: SAFE_PATH.optional(),
      cliService: OPENCLAW_SERVICE.optional(),
      profile: SAFE_ARG.optional(),
      dev: z.boolean().default(false),
      limit: z.number().int().positive().max(5000).default(200),
      maxBytes: z.number().int().positive().max(5_000_000).default(250000),
      format: z.enum(["plain", "json"]).default("plain"),
      url: z.string().optional(),
      token: z.string().optional(),
      timeout: z.number().int().positive().max(120000).default(30000)
    },
    async ({ hostId, mode, cliPath, composeDir, cliService, profile, dev, limit, maxBytes, format, url, token, timeout }) => {
      const host = assertAllowedHost(hostId);
      const args = appendGatewayClientFlags(
        [
          "logs",
          "--limit",
          String(limit),
          "--max-bytes",
          String(maxBytes),
          format === "json" ? "--json" : "--plain",
          "--no-color"
        ],
        { url, token, timeout }
      );
      const { runner, result } = await runOpenClaw(
        host,
        { config, ssh },
        { mode, cliPath, composeDir, cliService, profile, dev },
        args,
        timeout + 5000
      );
      return {
        content: jsonText(resultEnvelope(host, runner, result))
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_doctor_lint",
    "Run OpenClaw doctor lint",
    "Run read-only `openclaw doctor --lint --json` for health findings.",
    {
      hostId: z.string(),
      mode: OPENCLAW_MODE,
      cliPath: SAFE_PATH.optional(),
      composeDir: SAFE_PATH.optional(),
      cliService: OPENCLAW_SERVICE.optional(),
      profile: SAFE_ARG.optional(),
      dev: z.boolean().default(false),
      severityMin: z.enum(["info", "warning", "error"]).optional(),
      only: z.array(SAFE_ARG).max(20).default([]),
      skip: z.array(SAFE_ARG).max(20).default([]),
      allowExec: z.boolean().default(false),
      timeoutMs: z.number().int().positive().max(180000).default(60000)
    },
    async ({ hostId, mode, cliPath, composeDir, cliService, profile, dev, severityMin, only, skip, allowExec, timeoutMs }) => {
      const host = assertAllowedHost(hostId);
      const args = ["doctor", "--lint", "--json"];
      if (severityMin) {
        args.push("--severity-min", severityMin);
      }
      for (const check of only) {
        args.push("--only", check);
      }
      for (const check of skip) {
        args.push("--skip", check);
      }
      if (allowExec) {
        args.push("--allow-exec");
      }
      const { runner, result } = await runOpenClaw(
        host,
        { config, ssh },
        { mode, cliPath, composeDir, cliService, profile, dev },
        args,
        timeoutMs
      );
      return {
        content: jsonText(resultEnvelope(host, runner, result))
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_channels_status",
    "Get OpenClaw channel status",
    "Return configured channel/account runtime state via `openclaw channels status --json`.",
    openClawCommonSchema({
      probe: z.boolean().default(false),
      deep: z.boolean().default(false)
    }),
    async ({ hostId, timeoutMs, probe, deep, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      const args = ["channels", "status", "--json"];
      if (probe) {
        args.push("--probe");
      }
      if (deep) {
        args.push("--deep");
      }
      return {
        content: jsonText(
          await runOpenClawEnvelope(host, { config, ssh }, runnerOptionsFromArgs(runnerArgs), args, timeoutMs)
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_channels_list",
    "List OpenClaw channels",
    "List configured chat channels, optionally including the installable catalog.",
    openClawCommonSchema({
      all: z.boolean().default(false)
    }),
    async ({ hostId, timeoutMs, all, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      const args = ["channels", "list", "--json"];
      if (all) {
        args.push("--all");
      }
      return {
        content: jsonText(
          await runOpenClawEnvelope(host, { config, ssh }, runnerOptionsFromArgs(runnerArgs), args, timeoutMs)
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_channels_logs",
    "Fetch OpenClaw channel logs",
    "Show recent channel-specific log lines from the gateway log file.",
    openClawCommonSchema({
      channel: SAFE_ARG.default("all"),
      lines: z.number().int().positive().max(5000).default(200)
    }),
    async ({ hostId, timeoutMs, channel, lines, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      return {
        content: jsonText(
          await runOpenClawEnvelope(
            host,
            { config, ssh },
            runnerOptionsFromArgs(runnerArgs),
            ["channels", "logs", "--json", "--channel", channel, "--lines", String(lines)],
            timeoutMs
          )
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_models_status",
    "Get OpenClaw model status",
    "Return model/provider auth state via `openclaw models status --json`.",
    openClawCommonSchema({
      agent: SAFE_ARG.optional()
    }),
    async ({ hostId, timeoutMs, agent, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      const args = ["models", "status", "--json"];
      if (agent) {
        args.push("--agent", agent);
      }
      return {
        content: jsonText(
          await runOpenClawEnvelope(host, { config, ssh }, runnerOptionsFromArgs(runnerArgs), args, timeoutMs)
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_models_list",
    "List OpenClaw models",
    "List configured models via `openclaw models list --json`.",
    openClawCommonSchema({
      agent: SAFE_ARG.optional()
    }),
    async ({ hostId, timeoutMs, agent, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      const args = ["models", "list", "--json"];
      if (agent) {
        args.push("--agent", agent);
      }
      return {
        content: jsonText(
          await runOpenClawEnvelope(host, { config, ssh }, runnerOptionsFromArgs(runnerArgs), args, timeoutMs)
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_agents_list",
    "List OpenClaw agents",
    "List configured isolated agents.",
    openClawCommonSchema(),
    async ({ hostId, timeoutMs, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      return {
        content: jsonText(
          await runOpenClawEnvelope(
            host,
            { config, ssh },
            runnerOptionsFromArgs(runnerArgs),
            ["agents", "list", "--json"],
            timeoutMs
          )
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_agents_bindings",
    "List OpenClaw agent bindings",
    "List routing bindings for isolated agents.",
    openClawCommonSchema(),
    async ({ hostId, timeoutMs, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      return {
        content: jsonText(
          await runOpenClawEnvelope(
            host,
            { config, ssh },
            runnerOptionsFromArgs(runnerArgs),
            ["agents", "bindings", "--json"],
            timeoutMs
          )
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_sessions_list",
    "List OpenClaw sessions",
    "List stored conversation sessions with token usage where available.",
    openClawCommonSchema({
      agent: SAFE_ARG.optional(),
      allAgents: z.boolean().default(false),
      activeMinutes: z.number().int().positive().max(100000).optional(),
      limit: z.union([z.number().int().positive().max(5000), z.literal("all")]).default(100),
      store: SAFE_PATH.optional()
    }),
    async ({ hostId, timeoutMs, agent, allAgents, activeMinutes, limit, store, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      const args = ["sessions", "--json", "--limit", String(limit)];
      if (agent) {
        args.push("--agent", agent);
      }
      if (allAgents) {
        args.push("--all-agents");
      }
      if (activeMinutes) {
        args.push("--active", String(activeMinutes));
      }
      if (store) {
        args.push("--store", store);
      }
      return {
        content: jsonText(
          await runOpenClawEnvelope(host, { config, ssh }, runnerOptionsFromArgs(runnerArgs), args, timeoutMs)
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_tasks_list",
    "List OpenClaw tasks",
    "List durable background tasks and TaskFlow state.",
    openClawCommonSchema({
      runtime: OPENCLAW_TASK_RUNTIME.optional(),
      status: OPENCLAW_TASK_STATUS.optional()
    }),
    async ({ hostId, timeoutMs, runtime, status, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      const args = ["tasks", "list", "--json"];
      if (runtime) {
        args.push("--runtime", runtime);
      }
      if (status) {
        args.push("--status", status);
      }
      return {
        content: jsonText(
          await runOpenClawEnvelope(host, { config, ssh }, runnerOptionsFromArgs(runnerArgs), args, timeoutMs)
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_tasks_audit",
    "Audit OpenClaw tasks",
    "Show stale or broken background tasks and TaskFlows.",
    openClawCommonSchema({
      severity: OPENCLAW_TASK_AUDIT_SEVERITY.optional(),
      code: SAFE_ARG.optional(),
      limit: z.number().int().positive().max(5000).optional()
    }),
    async ({ hostId, timeoutMs, severity, code, limit, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      const args = ["tasks", "audit", "--json"];
      if (severity) {
        args.push("--severity", severity);
      }
      if (code) {
        args.push("--code", code);
      }
      if (limit) {
        args.push("--limit", String(limit));
      }
      return {
        content: jsonText(
          await runOpenClawEnvelope(host, { config, ssh }, runnerOptionsFromArgs(runnerArgs), args, timeoutMs)
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_task_show",
    "Show OpenClaw task",
    "Show one background task by task id, run id, or session key.",
    openClawCommonSchema({
      lookup: SAFE_ARG
    }),
    async ({ hostId, timeoutMs, lookup, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      return {
        content: jsonText(
          await runOpenClawEnvelope(
            host,
            { config, ssh },
            runnerOptionsFromArgs(runnerArgs),
            ["tasks", "show", lookup, "--json"],
            timeoutMs
          )
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_secrets_audit",
    "Audit OpenClaw secrets",
    "Audit plaintext secrets, unresolved SecretRefs, and precedence drift.",
    openClawCommonSchema({
      check: z.boolean().default(false),
      allowExec: z.boolean().default(false)
    }),
    async ({ hostId, timeoutMs, check, allowExec, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      const args = ["secrets", "audit", "--json"];
      if (check) {
        args.push("--check");
      }
      if (allowExec) {
        args.push("--allow-exec");
      }
      return {
        content: jsonText(
          await runOpenClawEnvelope(host, { config, ssh }, runnerOptionsFromArgs(runnerArgs), args, timeoutMs)
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_security_audit",
    "Audit OpenClaw security",
    "Audit local config and state for common security foot-guns.",
    openClawCommonSchema({
      deep: z.boolean().default(false),
      auth: OPENCLAW_SECURITY_AUTH.optional(),
      url: z.string().optional(),
      token: z.string().optional(),
      password: z.string().optional()
    }),
    async ({ hostId, timeoutMs, deep, auth, url, token, password, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      const args = appendGatewayClientFlags(["security", "audit", "--json"], {
        url,
        token,
        password
      });
      if (deep) {
        args.push("--deep");
      }
      if (auth) {
        args.push("--auth", auth);
      }
      return {
        content: jsonText(
          await runOpenClawEnvelope(host, { config, ssh }, runnerOptionsFromArgs(runnerArgs), args, timeoutMs)
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_plugins_list",
    "List OpenClaw plugins",
    "List discovered OpenClaw plugins and dependency/load state.",
    openClawCommonSchema(),
    async ({ hostId, timeoutMs, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      return {
        content: jsonText(
          await runOpenClawEnvelope(
            host,
            { config, ssh },
            runnerOptionsFromArgs(runnerArgs),
            ["plugins", "list", "--json"],
            timeoutMs
          )
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_plugins_doctor",
    "Run OpenClaw plugin doctor",
    "Report plugin load issues.",
    openClawCommonSchema(),
    async ({ hostId, timeoutMs, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      return {
        content: jsonText(
          await runOpenClawEnvelope(
            host,
            { config, ssh },
            runnerOptionsFromArgs(runnerArgs),
            ["plugins", "doctor"],
            timeoutMs
          )
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_memory_status",
    "Get OpenClaw memory status",
    "Show memory search index and provider status.",
    openClawCommonSchema({
      agent: SAFE_ARG.optional(),
      deep: z.boolean().default(false)
    }),
    async ({ hostId, timeoutMs, agent, deep, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      const args = ["memory", "status", "--json"];
      if (agent) {
        args.push("--agent", agent);
      }
      if (deep) {
        args.push("--deep");
      }
      return {
        content: jsonText(
          await runOpenClawEnvelope(host, { config, ssh }, runnerOptionsFromArgs(runnerArgs), args, timeoutMs)
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_memory_search",
    "Search OpenClaw memory",
    "Search memory files for a query.",
    openClawCommonSchema({
      query: z.string().min(1).max(4096).refine((value) => !value.includes("\0")),
      agent: SAFE_ARG.optional(),
      maxResults: z.number().int().positive().max(1000).optional(),
      minScore: z.number().min(0).max(1).optional()
    }),
    async ({ hostId, timeoutMs, query, agent, maxResults, minScore, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      const args = ["memory", "search", "--json", "--query", query];
      if (agent) {
        args.push("--agent", agent);
      }
      if (maxResults) {
        args.push("--max-results", String(maxResults));
      }
      if (minScore !== undefined) {
        args.push("--min-score", String(minScore));
      }
      return {
        content: jsonText(
          await runOpenClawEnvelope(host, { config, ssh }, runnerOptionsFromArgs(runnerArgs), args, timeoutMs)
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_mcp_list",
    "List OpenClaw MCP servers",
    "List configured MCP servers in OpenClaw.",
    openClawCommonSchema(),
    async ({ hostId, timeoutMs, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      return {
        content: jsonText(
          await runOpenClawEnvelope(
            host,
            { config, ssh },
            runnerOptionsFromArgs(runnerArgs),
            ["mcp", "list", "--json"],
            timeoutMs
          )
        )
      };
    }
  );

  readonlyTool(
    server,
    "openclaw_mcp_show",
    "Show OpenClaw MCP config",
    "Show one configured MCP server or the full MCP config.",
    openClawCommonSchema({
      name: SAFE_ARG.optional()
    }),
    async ({ hostId, timeoutMs, name, ...runnerArgs }) => {
      const host = assertAllowedHost(hostId);
      const args = ["mcp", "show", "--json"];
      if (name) {
        args.push(name);
      }
      return {
        content: jsonText(
          await runOpenClawEnvelope(host, { config, ssh }, runnerOptionsFromArgs(runnerArgs), args, timeoutMs)
        )
      };
    }
  );

  destructiveTool(
    server,
    "openclaw_doctor_fix",
    "Run OpenClaw doctor repair",
    "Run `openclaw doctor --fix` with non-interactive repair options. This can edit OpenClaw config/state and should be treated as a high-privilege operation.",
    {
      hostId: z.string(),
      mode: OPENCLAW_MODE,
      cliPath: SAFE_PATH.optional(),
      composeDir: SAFE_PATH.optional(),
      cliService: OPENCLAW_SERVICE.optional(),
      profile: SAFE_ARG.optional(),
      dev: z.boolean().default(false),
      nonInteractive: z.boolean().default(true),
      yes: z.boolean().default(true),
      force: z.boolean().default(false),
      allowExec: z.boolean().default(false),
      generateGatewayToken: z.boolean().default(false),
      timeoutMs: z.number().int().positive().max(300000).default(120000)
    },
    async ({ hostId, mode, cliPath, composeDir, cliService, profile, dev, nonInteractive, yes, force, allowExec, generateGatewayToken, timeoutMs }) => {
      const host = assertAllowedHost(hostId);
      const args = ["doctor", "--fix"];
      if (yes) {
        args.push("--yes");
      }
      if (nonInteractive) {
        args.push("--non-interactive");
      }
      if (force) {
        args.push("--force");
      }
      if (allowExec) {
        args.push("--allow-exec");
      }
      if (generateGatewayToken) {
        args.push("--generate-gateway-token");
      }
      const { runner, result } = await runOpenClaw(
        host,
        { config, ssh },
        { mode, cliPath, composeDir, cliService, profile, dev },
        args,
        timeoutMs
      );
      return {
        content: jsonText(resultEnvelope(host, runner, result))
      };
    },
    { openWorld: true }
  );

  destructiveTool(
    server,
    "openclaw_gateway_action",
    "Manage OpenClaw gateway",
    "Start, stop, restart, install, or uninstall the OpenClaw gateway through the native CLI or Docker Compose.",
    {
      hostId: z.string(),
      action: OPENCLAW_ACTION,
      mode: OPENCLAW_MODE,
      cliPath: SAFE_PATH.optional(),
      composeDir: SAFE_PATH.optional(),
      cliService: OPENCLAW_SERVICE.optional(),
      gatewayService: OPENCLAW_SERVICE.optional(),
      profile: SAFE_ARG.optional(),
      dev: z.boolean().default(false),
      port: z.number().int().positive().max(65535).optional(),
      runtime: z.enum(["node", "bun"]).optional(),
      token: z.string().optional(),
      force: z.boolean().default(false),
      safe: z.boolean().default(false),
      skipDeferral: z.boolean().default(false),
      disable: z.boolean().default(false),
      wait: SAFE_ARG.optional(),
      timeoutMs: z.number().int().positive().max(300000).default(120000)
    },
    async ({ hostId, action, mode, cliPath, composeDir, cliService, gatewayService, profile, dev, port, runtime, token, force, safe, skipDeferral, disable, wait, timeoutMs }) => {
      const host = assertAllowedHost(hostId);
      const runner = await resolveRunner(host, { config, ssh }, { mode, cliPath, composeDir, cliService, profile, dev });

      if (runner.mode === "compose") {
        const service = gatewayService ?? config.openclawGatewayService;
        const composeArgs =
          action === "restart"
            ? ["docker", "compose", "restart", service]
            : action === "stop"
              ? ["docker", "compose", "stop", service]
              : action === "uninstall"
                ? ["docker", "compose", "down"]
                : ["docker", "compose", "up", "-d", service];
        const result = await ssh.runSsh(
          host,
          remoteCommandInDir(runner.composeDir ?? "", joinShellCommand(composeArgs)),
          timeoutMs
        );
        return {
          content: jsonText(resultEnvelope(host, runner, result))
        };
      }

      const args = ["gateway", action, "--json"];
      if (action === "install") {
        if (port) {
          args.push("--port", String(port));
        }
        if (runtime) {
          args.push("--runtime", runtime);
        }
        if (token) {
          args.push("--token", token);
        }
        if (force) {
          args.push("--force");
        }
      }
      if (action === "restart") {
        if (safe) {
          args.push("--safe");
        }
        if (skipDeferral) {
          args.push("--skip-deferral");
        }
        if (force) {
          args.push("--force");
        }
        if (wait) {
          args.push("--wait", wait);
        }
      }
      if (action === "stop" && disable) {
        args.push("--disable");
      }

      const result = await ssh.runSsh(
        host,
        buildOpenClawCommand(runner, { mode, cliPath, composeDir, cliService, profile, dev }, args),
        timeoutMs
      );
      return {
        content: jsonText(resultEnvelope(host, runner, result))
      };
    },
    { openWorld: true }
  );

  destructiveTool(
    server,
    "openclaw_update",
    "Update OpenClaw",
    "Update OpenClaw. Native mode runs `openclaw update`; Compose mode pulls images and recreates the stack.",
    {
      hostId: z.string(),
      mode: OPENCLAW_MODE,
      cliPath: SAFE_PATH.optional(),
      composeDir: SAFE_PATH.optional(),
      cliService: OPENCLAW_SERVICE.optional(),
      profile: SAFE_ARG.optional(),
      dev: z.boolean().default(false),
      channel: z.enum(["stable", "dev"]).optional(),
      postUpgradeDoctor: z.boolean().default(true),
      timeoutMs: z.number().int().positive().max(900000).default(600000)
    },
    async ({ hostId, mode, cliPath, composeDir, cliService, profile, dev, channel, postUpgradeDoctor, timeoutMs }) => {
      const host = assertAllowedHost(hostId);
      const options = { mode, cliPath, composeDir, cliService, profile, dev };
      const runner = await resolveRunner(host, { config, ssh }, options);

      if (runner.mode === "compose") {
        const update = await ssh.runSsh(
          host,
          remoteCommandInDir(runner.composeDir ?? "", "docker compose pull && docker compose up -d"),
          timeoutMs
        );
        const doctor = postUpgradeDoctor
          ? await ssh.runSsh(
              host,
              buildOpenClawCommand(runner, options, ["doctor", "--post-upgrade", "--json"]),
              180000
            )
          : null;
        return {
          content: jsonText({
            update: resultEnvelope(host, runner, update),
            doctor: doctor ? resultEnvelope(host, runner, doctor) : null
          })
        };
      }

      const updateArgs = ["update"];
      if (channel) {
        updateArgs.push("--channel", channel);
      }
      const update = await ssh.runSsh(host, buildOpenClawCommand(runner, options, updateArgs), timeoutMs);
      const doctor = postUpgradeDoctor
        ? await ssh.runSsh(
            host,
            buildOpenClawCommand(runner, options, ["doctor", "--post-upgrade", "--json"]),
            180000
          )
        : null;
      return {
        content: jsonText({
          update: resultEnvelope(host, runner, update),
          doctor: doctor ? resultEnvelope(host, runner, doctor) : null
        })
      };
    },
    { openWorld: true }
  );

  readonlyTool(
    server,
    "openclaw_devices_list",
    "List OpenClaw devices",
    "List pending OpenClaw pairing requests and paired devices.",
    {
      hostId: z.string(),
      mode: OPENCLAW_MODE,
      cliPath: SAFE_PATH.optional(),
      composeDir: SAFE_PATH.optional(),
      cliService: OPENCLAW_SERVICE.optional(),
      profile: SAFE_ARG.optional(),
      dev: z.boolean().default(false),
      url: z.string().optional(),
      token: z.string().optional(),
      password: z.string().optional(),
      timeout: z.number().int().positive().max(120000).default(30000)
    },
    async ({ hostId, mode, cliPath, composeDir, cliService, profile, dev, url, token, password, timeout }) => {
      const host = assertAllowedHost(hostId);
      const args = appendGatewayClientFlags(["devices", "list", "--json"], {
        url,
        token,
        password,
        timeout
      });
      const { runner, result } = await runOpenClaw(
        host,
        { config, ssh },
        { mode, cliPath, composeDir, cliService, profile, dev },
        args,
        timeout + 5000
      );
      return {
        content: jsonText(resultEnvelope(host, runner, result))
      };
    }
  );

  destructiveTool(
    server,
    "openclaw_device_approve",
    "Approve OpenClaw device",
    "Approve a pending OpenClaw device pairing request by exact requestId.",
    {
      hostId: z.string(),
      requestId: SAFE_ARG,
      mode: OPENCLAW_MODE,
      cliPath: SAFE_PATH.optional(),
      composeDir: SAFE_PATH.optional(),
      cliService: OPENCLAW_SERVICE.optional(),
      profile: SAFE_ARG.optional(),
      dev: z.boolean().default(false),
      url: z.string().optional(),
      token: z.string().optional(),
      password: z.string().optional(),
      timeout: z.number().int().positive().max(120000).default(30000)
    },
    async ({ hostId, requestId, mode, cliPath, composeDir, cliService, profile, dev, url, token, password, timeout }) => {
      const host = assertAllowedHost(hostId);
      const args = appendGatewayClientFlags(["devices", "approve", requestId, "--json"], {
        url,
        token,
        password,
        timeout
      });
      const { runner, result } = await runOpenClaw(
        host,
        { config, ssh },
        { mode, cliPath, composeDir, cliService, profile, dev },
        args,
        timeout + 5000
      );
      return {
        content: jsonText(resultEnvelope(host, runner, result))
      };
    },
    { openWorld: true }
  );

  destructiveTool(
    server,
    "openclaw_device_reject",
    "Reject OpenClaw device",
    "Reject a pending OpenClaw device pairing request by exact requestId.",
    {
      hostId: z.string(),
      requestId: SAFE_ARG,
      mode: OPENCLAW_MODE,
      cliPath: SAFE_PATH.optional(),
      composeDir: SAFE_PATH.optional(),
      cliService: OPENCLAW_SERVICE.optional(),
      profile: SAFE_ARG.optional(),
      dev: z.boolean().default(false),
      url: z.string().optional(),
      token: z.string().optional(),
      password: z.string().optional(),
      timeout: z.number().int().positive().max(120000).default(30000)
    },
    async ({ hostId, requestId, mode, cliPath, composeDir, cliService, profile, dev, url, token, password, timeout }) => {
      const host = assertAllowedHost(hostId);
      const args = appendGatewayClientFlags(["devices", "reject", requestId, "--json"], {
        url,
        token,
        password,
        timeout
      });
      const { runner, result } = await runOpenClaw(
        host,
        { config, ssh },
        { mode, cliPath, composeDir, cliService, profile, dev },
        args,
        timeout + 5000
      );
      return {
        content: jsonText(resultEnvelope(host, runner, result))
      };
    },
    { openWorld: true }
  );

  destructiveTool(
    server,
    "openclaw_device_remove",
    "Remove OpenClaw device",
    "Remove a paired OpenClaw device entry by exact deviceId.",
    {
      hostId: z.string(),
      deviceId: SAFE_ARG,
      mode: OPENCLAW_MODE,
      cliPath: SAFE_PATH.optional(),
      composeDir: SAFE_PATH.optional(),
      cliService: OPENCLAW_SERVICE.optional(),
      profile: SAFE_ARG.optional(),
      dev: z.boolean().default(false),
      url: z.string().optional(),
      token: z.string().optional(),
      password: z.string().optional(),
      timeout: z.number().int().positive().max(120000).default(30000)
    },
    async ({ hostId, deviceId, mode, cliPath, composeDir, cliService, profile, dev, url, token, password, timeout }) => {
      const host = assertAllowedHost(hostId);
      const args = appendGatewayClientFlags(["devices", "remove", deviceId, "--json"], {
        url,
        token,
        password,
        timeout
      });
      const { runner, result } = await runOpenClaw(
        host,
        { config, ssh },
        { mode, cliPath, composeDir, cliService, profile, dev },
        args,
        timeout + 5000
      );
      return {
        content: jsonText(resultEnvelope(host, runner, result))
      };
    },
    { openWorld: true }
  );

  destructiveTool(
    server,
    "openclaw_devices_clear",
    "Clear OpenClaw devices",
    "Clear paired devices from the gateway table, optionally rejecting pending pairing requests.",
    {
      hostId: z.string(),
      pending: z.boolean().default(false),
      yes: z.boolean().default(true),
      mode: OPENCLAW_MODE,
      cliPath: SAFE_PATH.optional(),
      composeDir: SAFE_PATH.optional(),
      cliService: OPENCLAW_SERVICE.optional(),
      profile: SAFE_ARG.optional(),
      dev: z.boolean().default(false),
      url: z.string().optional(),
      token: z.string().optional(),
      password: z.string().optional(),
      timeout: z.number().int().positive().max(120000).default(30000)
    },
    async ({ hostId, pending, yes, mode, cliPath, composeDir, cliService, profile, dev, url, token, password, timeout }) => {
      const host = assertAllowedHost(hostId);
      const args = appendGatewayClientFlags(["devices", "clear", "--json"], {
        url,
        token,
        password,
        timeout
      });
      if (pending) {
        args.push("--pending");
      }
      if (yes) {
        args.push("--yes");
      }
      const { runner, result } = await runOpenClaw(
        host,
        { config, ssh },
        { mode, cliPath, composeDir, cliService, profile, dev },
        args,
        timeout + 5000
      );
      return {
        content: jsonText(resultEnvelope(host, runner, result))
      };
    },
    { openWorld: true }
  );

  destructiveTool(
    server,
    "openclaw_device_revoke",
    "Revoke OpenClaw device token",
    "Revoke a device token for a role.",
    {
      hostId: z.string(),
      deviceId: SAFE_ARG,
      role: SAFE_ARG,
      mode: OPENCLAW_MODE,
      cliPath: SAFE_PATH.optional(),
      composeDir: SAFE_PATH.optional(),
      cliService: OPENCLAW_SERVICE.optional(),
      profile: SAFE_ARG.optional(),
      dev: z.boolean().default(false),
      url: z.string().optional(),
      token: z.string().optional(),
      password: z.string().optional(),
      timeout: z.number().int().positive().max(120000).default(30000)
    },
    async ({ hostId, deviceId, role, mode, cliPath, composeDir, cliService, profile, dev, url, token, password, timeout }) => {
      const host = assertAllowedHost(hostId);
      const args = appendGatewayClientFlags(
        ["devices", "revoke", "--json", "--device", deviceId, "--role", role],
        { url, token, password, timeout }
      );
      const { runner, result } = await runOpenClaw(
        host,
        { config, ssh },
        { mode, cliPath, composeDir, cliService, profile, dev },
        args,
        timeout + 5000
      );
      return {
        content: jsonText(resultEnvelope(host, runner, result))
      };
    },
    { openWorld: true }
  );

  destructiveTool(
    server,
    "openclaw_device_rotate",
    "Rotate OpenClaw device token",
    "Rotate a device token for a role and optional scopes.",
    {
      hostId: z.string(),
      deviceId: SAFE_ARG,
      role: SAFE_ARG,
      scopes: z.array(SAFE_ARG).max(20).default([]),
      mode: OPENCLAW_MODE,
      cliPath: SAFE_PATH.optional(),
      composeDir: SAFE_PATH.optional(),
      cliService: OPENCLAW_SERVICE.optional(),
      profile: SAFE_ARG.optional(),
      dev: z.boolean().default(false),
      url: z.string().optional(),
      token: z.string().optional(),
      password: z.string().optional(),
      timeout: z.number().int().positive().max(120000).default(30000)
    },
    async ({ hostId, deviceId, role, scopes, mode, cliPath, composeDir, cliService, profile, dev, url, token, password, timeout }) => {
      const host = assertAllowedHost(hostId);
      const args = appendGatewayClientFlags(
        ["devices", "rotate", "--json", "--device", deviceId, "--role", role],
        { url, token, password, timeout }
      );
      for (const scope of scopes) {
        args.push("--scope", scope);
      }
      const { runner, result } = await runOpenClaw(
        host,
        { config, ssh },
        { mode, cliPath, composeDir, cliService, profile, dev },
        args,
        timeout + 5000
      );
      return {
        content: jsonText(resultEnvelope(host, runner, result))
      };
    },
    { openWorld: true }
  );

  destructiveTool(
    server,
    "openclaw_cli",
    "Run OpenClaw CLI",
    "Run a high-privilege OpenClaw CLI command through the configured native CLI or Docker Compose CLI sidecar. This does not expose arbitrary shell, but OpenClaw subcommands may mutate config, services, devices, plugins, channels, sessions, or remote gateways.",
    {
      hostId: z.string(),
      args: z.array(SAFE_ARG).min(1).max(80),
      mode: OPENCLAW_MODE,
      cliPath: SAFE_PATH.optional(),
      composeDir: SAFE_PATH.optional(),
      cliService: OPENCLAW_SERVICE.optional(),
      profile: SAFE_ARG.optional(),
      dev: z.boolean().default(false),
      env: SAFE_ENV.default({}),
      timeoutMs: z.number().int().positive().max(900000).default(120000)
    },
    async ({ hostId, args, mode, cliPath, composeDir, cliService, profile, dev, env, timeoutMs }) => {
      const host = assertAllowedHost(hostId);
      const { runner, result } = await runOpenClaw(
        host,
        { config, ssh },
        { mode, cliPath, composeDir, cliService, profile, dev, env },
        args,
        timeoutMs
      );
      return {
        content: jsonText(resultEnvelope(host, runner, result))
      };
    },
    { openWorld: true }
  );
}
