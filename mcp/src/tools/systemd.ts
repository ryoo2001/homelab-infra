import { z } from "zod";
import { jsonText, parseLines, readonlyTool, destructiveTool, shellQuote, systemctlActionCommand } from "../helpers.js";
import type { Deps } from "./deps.js";

const SERVICE_NAME = z.string().regex(/^[a-zA-Z0-9_.@:-]+$/);

function assertAllowedService(config: any, service: string): void {
  if (config.allowedServices.length > 0 && !config.allowedServices.includes(service)) {
    throw new Error(
      `Service '${service}' not in whitelist. Allowed: ${config.allowedServices.join(", ") || "(none)"}`
    );
  }
}

export function registerSystemdTools({ server, config, ssh, assertAllowedHost }: Deps): void {
  readonlyTool(
    server,
    "service_status",
    "Check systemd service",
    "Query systemd status for a whitelist-managed service.",
    {
      hostId: z.string(),
      service: SERVICE_NAME
    },
    async ({ hostId, service }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runSsh(host, ["systemctl", "status", service, "--no-pager", "--plain"]);
      return {
        content: jsonText(result)
      };
    }
  );

  readonlyTool(
    server,
    "service_list",
    "List systemd services",
    "List systemd services on the host with optional state filtering.",
    {
      hostId: z.string(),
      state: z.enum(["active", "failed", "inactive", "all"]).default("active"),
      limit: z.number().int().positive().max(200).default(50)
    },
    async ({ hostId, state, limit }) => {
      const host = assertAllowedHost(hostId);
      const stateArg = state === "all" ? "" : ` --state=${state}`;
      const command = `systemctl list-units --type=service --all --no-legend --no-pager${stateArg} | head -n ${limit}`;
      const result = await ssh.runSsh(host, command);
      return {
        content: jsonText({
          host: host.host,
          state,
          limit,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "service_is_active",
    "Check whether a service is active",
    "Return whether a systemd service is active, failed, enabled, or masked.",
    {
      hostId: z.string(),
      service: SERVICE_NAME
    },
    async ({ hostId, service }) => {
      const host = assertAllowedHost(hostId);
      const batch = await ssh.runBatch(host, [
        { name: "active", command: `systemctl is-active ${shellQuote(service)}` },
        { name: "enabled", command: `systemctl is-enabled ${shellQuote(service)}` }
      ]);
      return {
        content: jsonText({
          host: host.host,
          service,
          active: batch.outputs.active.trim() || "unknown",
          enabled: batch.outputs.enabled.trim() || "unknown",
          code: batch.code
        })
      };
    }
  );

  const lifecycle = [
    { name: "service_restart", title: "Restart systemd service", description: "Restart a whitelisted systemd service on a managed host.", action: "restart" as const, idempotent: false },
    { name: "service_start", title: "Start systemd service", description: "Start a systemd service on the managed host.", action: "start" as const, idempotent: false },
    { name: "service_stop", title: "Stop systemd service", description: "Stop a systemd service on the managed host.", action: "stop" as const, idempotent: false },
    { name: "service_reload", title: "Reload systemd service", description: "Reload a systemd service on the managed host.", action: "reload" as const, idempotent: true },
    { name: "service_enable", title: "Enable systemd service", description: "Enable a systemd service to start at boot.", action: "enable" as const, idempotent: false },
    { name: "service_disable", title: "Disable systemd service", description: "Disable a systemd service so it does not start at boot.", action: "disable" as const, idempotent: false },
    { name: "service_mask", title: "Mask systemd service", description: "Mask a systemd service to prevent manual or automatic starts.", action: "mask" as const, idempotent: false },
    { name: "service_unmask", title: "Unmask systemd service", description: "Unmask a systemd service so it can start again.", action: "unmask" as const, idempotent: false }
  ];

  for (const entry of lifecycle) {
    destructiveTool(
      server,
      entry.name,
      entry.title,
      entry.description,
      {
        hostId: z.string(),
        service: SERVICE_NAME
      },
      async ({ hostId, service }) => {
        assertAllowedService(config, service);
        const host = assertAllowedHost(hostId);
        const result = await ssh.runSsh(host, systemctlActionCommand(entry.action, service));
        return {
          content: jsonText(result)
        };
      },
      { idempotent: entry.idempotent }
    );
  }

  readonlyTool(
    server,
    "server_logs",
    "Fetch service logs",
    "Fetch recent journalctl logs for a managed host and systemd service.",
    {
      hostId: z.string(),
      service: SERVICE_NAME,
      lines: z.number().int().positive().max(500).default(100)
    },
    async ({ hostId, service, lines }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runSsh(host, ["journalctl", "-u", service, "-n", String(lines), "--no-pager"]);
      return {
        content: jsonText(result)
      };
    }
  );

  readonlyTool(
    server,
    "journal_errors",
    "Fetch journal errors",
    "Fetch recent journal entries at error severity and above.",
    {
      hostId: z.string(),
      lines: z.number().int().positive().max(500).default(100)
    },
    async ({ hostId, lines }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runSsh(host, `journalctl -p err..alert -n ${lines} --no-pager -o short-iso`);
      return {
        content: jsonText({
          host: host.host,
          lines,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "server_timers",
    "List systemd timers",
    "List active and inactive systemd timers on the host.",
    {
      hostId: z.string(),
      all: z.boolean().default(true)
    },
    async ({ hostId, all }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runSsh(
        host,
        ["systemctl", "list-timers", "--all", "--no-legend", "--no-pager", all ? "" : "--state=active"].filter(Boolean)
      );
      return {
        content: jsonText({
          host: host.host,
          timers: parseLines(result.stdout),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "server_failed_units",
    "List failed units",
    "List failed systemd units on the host.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runSsh(host, ["systemctl", "list-units", "--failed", "--no-legend", "--no-pager"]);
      return {
        content: jsonText({
          host: host.host,
          failedUnits: parseLines(result.stdout),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "journal_error_summary",
    "Summarize journal errors by unit",
    "Parse recent journal errors and summarize top units with error counts and sample messages.",
    {
      hostId: z.string(),
      since: z.string().default("24 hours ago"),
      limit: z.number().int().positive().max(50).default(10)
    },
    async ({ hostId, since, limit }) => {
      const host = assertAllowedHost(hostId);
      // Fetch JSONL output; each line is one journal entry
      const result = await ssh.runSsh(
        host,
        `journalctl -p err..alert --since ${shellQuote(since)} -n 2000 --no-pager -o json 2>/dev/null || journalctl -p err..alert --since ${shellQuote(since)} -n 2000 --no-pager -o short-iso`
      );
      const units = new Map<string, { count: number; samples: string[] }>();
      for (const line of parseLines(result.stdout)) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          const unit = (entry["_SYSTEMD_UNIT"] ?? entry["SYSLOG_IDENTIFIER"] ?? "unknown") as string;
          const msg = String(entry["MESSAGE"] ?? "").slice(0, 120);
          const rec = units.get(unit) ?? { count: 0, samples: [] };
          rec.count++;
          if (rec.samples.length < 3) rec.samples.push(msg);
          units.set(unit, rec);
        } catch {
          // non-JSON fallback line — skip grouping
        }
      }
      const grouped = Array.from(units.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, limit)
        .map(([unit, { count, samples }]) => ({ unit, count, samples }));
      return {
        content: jsonText({
          host: host.host,
          since,
          topUnits: grouped.length > 0 ? grouped : undefined,
          raw: grouped.length === 0 ? result.stdout.trim() : undefined,
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );
}
