import { z } from "zod";
import {
  joinShellCommand,
  jsonText,
  optionalCommand,
  parseLines,
  readonlyTool,
  destructiveTool,
  safeNetworkTarget,
  systemctlActionCommand
} from "../helpers.js";
import type { Deps } from "./deps.js";
import type { HostConfig } from "../config.js";
import type { SshExecutor } from "../ssh.js";

async function collectServerSnapshot(host: HostConfig, ssh: SshExecutor) {
  const batch = await ssh.runBatch(host, [
    { name: "hostname", command: "hostname" },
    { name: "uname", command: "uname -srmo" },
    { name: "uptime", command: "uptime" },
    { name: "loadavg", command: "cat /proc/loadavg" },
    { name: "memory", command: "free -h" },
    { name: "disk", command: "df -h /" },
    { name: "who", command: "who" }
  ]);

  return {
    host: host.host,
    hostname: batch.outputs.hostname.trim(),
    kernel: batch.outputs.uname.trim(),
    uptime: batch.outputs.uptime.trim(),
    loadAverage: batch.outputs.loadavg.trim(),
    memory: batch.outputs.memory.trim(),
    disk: batch.outputs.disk.trim(),
    loggedInUsers: batch.outputs.who.trim()
  };
}

export function registerServerTools({ server, config, ssh, assertAllowedHost }: Deps): void {
  readonlyTool(
    server,
    "server_list",
    "List managed servers",
    "Return the configured Linux hosts that this MCP server is allowed to manage.",
    {},
    async () => ({
      content: jsonText(
        config.hosts.map((host) => ({
          id: host.id,
          host: host.host,
          ...(host.credentialId ? { credentialId: host.credentialId } : {}),
          ...(host.user ? { user: host.user } : {}),
          ...(host.port ? { port: host.port } : {})
        }))
      )
    })
  );

  readonlyTool(
    server,
    "server_status",
    "Check host status",
    "Check whether a managed Linux host is reachable over SSH.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runSsh(host, ["uname", "-a"]);
      return {
        content: jsonText({
          host: host.host,
          code: result.code,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim()
        })
      };
    }
  );

  readonlyTool(
    server,
    "server_info",
    "Get server summary",
    "Return a detailed Linux host summary including uptime, load, memory, disk, and logged-in users.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      return {
        content: jsonText(await collectServerSnapshot(host, ssh))
      };
    }
  );

  readonlyTool(
    server,
    "server_uptime",
    "Get uptime and load",
    "Return the host uptime and load averages.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runSsh(host, ["uptime"]);
      return {
        content: jsonText({
          host: host.host,
          uptime: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "server_health",
    "Check host health",
    "Collect a compact health snapshot from a Linux host.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const batch = await ssh.runBatch(host, [
        { name: "uptime", command: "uptime" },
        { name: "memory", command: "free -h" },
        { name: "disk", command: "df -h /" }
      ]);
      return {
        content: jsonText({
          host: host.host,
          uptime: batch.outputs.uptime.trim(),
          memory: batch.outputs.memory.trim(),
          disk: batch.outputs.disk.trim()
        })
      };
    }
  );

  readonlyTool(
    server,
    "server_processes",
    "List top processes",
    "Return a ranked list of the host's top processes by CPU or memory.",
    {
      hostId: z.string(),
      sortBy: z.enum(["cpu", "memory"]).default("cpu"),
      limit: z.number().int().positive().max(100).default(20)
    },
    async ({ hostId, sortBy, limit }) => {
      const host = assertAllowedHost(hostId);
      const sortColumn = sortBy === "memory" ? "-pmem" : "-pcpu";
      const command = `${joinShellCommand([
        "ps",
        "-eo",
        "pid,ppid,user,pcpu,pmem,comm,args",
        `--sort=${sortColumn}`
      ])} | head -n ${limit}`;
      const result = await ssh.runSsh(host, command);
      return {
        content: jsonText({
          host: host.host,
          sortBy,
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
    "server_ports",
    "List listening ports",
    "List listening TCP and UDP sockets on the host.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runSsh(host, "ss -tulpnH");
      return {
        content: jsonText({
          host: host.host,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "server_firewall",
    "Inspect firewall",
    "Return firewall state from firewalld when available.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const command = `sudo -n -- firewall-cmd --state && sudo -n -- firewall-cmd --get-active-zones && sudo -n -- firewall-cmd --list-all`;
      const result = await ssh.runSsh(host, command);
      return {
        content: jsonText({
          host: host.host,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "server_updates",
    "Check package updates",
    "Check whether OS package updates are available using the native package manager.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const command = joinShellCommand([
        "sh",
        "-lc",
        `
if command -v dnf >/dev/null 2>&1; then
  timeout 20s dnf -q check-update
  status=$?
  if [ "$status" -eq 0 ] || [ "$status" -eq 100 ]; then
    exit 0
  fi
  if [ "$status" -eq 124 ]; then
    echo "dnf check-update timed out"
    exit 0
  fi
  exit "$status"
elif command -v yum >/dev/null 2>&1; then
  timeout 20s yum -q check-update
  status=$?
  if [ "$status" -eq 0 ] || [ "$status" -eq 100 ]; then
    exit 0
  fi
  if [ "$status" -eq 124 ]; then
    echo "yum check-update timed out"
    exit 0
  fi
  exit "$status"
elif command -v apt >/dev/null 2>&1; then
  apt list --upgradable 2>/dev/null
else
  echo 'no supported package manager found'
fi
        `.trim()
      ]);
      const result = await ssh.runSsh(host, command, 30000);
      return {
        content: jsonText({
          host: host.host,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "server_selinux",
    "Check SELinux status",
    "Return SELinux status when the host uses it.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runSsh(
        host,
        optionalCommand("getenforce", "getenforce", "echo 'getenforce not available'")
      );
      return {
        content: jsonText({
          host: host.host,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "server_ping",
    "Ping target",
    "Run a small ping test from the managed host to a target address or hostname.",
    {
      hostId: z.string(),
      target: z.string(),
      count: z.number().int().positive().max(10).default(3)
    },
    async ({ hostId, target, count }) => {
      const host = assertAllowedHost(hostId);
      const sanitizedTarget = safeNetworkTarget(target);
      const result = await ssh.runSsh(host, ["ping", "-c", String(count), "-W", "2", sanitizedTarget]);
      return {
        content: jsonText({
          host: host.host,
          target: sanitizedTarget,
          count,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "server_network",
    "Inspect network state",
    "Return interface addresses, routing tables, and local resolver configuration.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const batch = await ssh.runBatch(host, [
        { name: "addr", command: "ip -brief addr" },
        { name: "route4", command: "ip route" },
        { name: "route6", command: "ip -6 route" },
        { name: "resolv", command: "cat /etc/resolv.conf" }
      ]);
      return {
        content: jsonText({
          host: host.host,
          interfaces: parseLines(batch.outputs.addr),
          ipv4Routes: parseLines(batch.outputs.route4),
          ipv6Routes: parseLines(batch.outputs.route6),
          resolverConfig: batch.outputs.resolv.trim()
        })
      };
    }
  );

  readonlyTool(
    server,
    "server_time",
    "Get server time",
    "Return local time, UTC time, and timezone details from the managed host.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const batch = await ssh.runBatch(host, [
        { name: "date", command: "date -Is" },
        { name: "timedatectl", command: "timedatectl status --no-pager" }
      ]);
      return {
        content: jsonText({
          host: host.host,
          date: batch.outputs.date.trim(),
          timedatectl: batch.outputs.timedatectl.trim() || batch.stderr.trim(),
          code: batch.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "server_mounts",
    "List mounted filesystems",
    "Return mounted filesystems and usage details.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runSsh(host, ["findmnt", "-rn", "-o", "TARGET,SOURCE,FSTYPE,OPTIONS"]);
      return {
        content: jsonText({
          host: host.host,
          mounts: parseLines(result.stdout),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "server_disk_usage",
    "Get disk usage",
    "Return filesystem usage for the host.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runSsh(host, ["df", "-hT"]);
      return {
        content: jsonText({
          host: host.host,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "server_memory",
    "Get memory snapshot",
    "Return free memory and top memory consumers.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const batch = await ssh.runBatch(host, [
        { name: "memory", command: "free -h" },
        { name: "swap", command: "swapon --show" },
        { name: "top", command: "ps -eo pid,user,pmem,pcpu,comm --sort=-pmem" }
      ]);
      return {
        content: jsonText({
          host: host.host,
          free: batch.outputs.memory.trim(),
          swap: batch.outputs.swap.trim(),
          topMemory: parseLines(batch.outputs.top).slice(0, 20)
        })
      };
    }
  );

  readonlyTool(
    server,
    "server_cpu",
    "Get CPU snapshot",
    "Return CPU model and load details.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const batch = await ssh.runBatch(host, [
        { name: "cpuinfo", command: "cat /proc/cpuinfo" },
        { name: "loadavg", command: "cat /proc/loadavg" },
        { name: "uptime", command: "uptime" }
      ]);
      const model = batch.outputs.cpuinfo.split(/\r?\n/).find((line) => line.startsWith("model name"));
      return {
        content: jsonText({
          host: host.host,
          cpuModel: model?.split(":")[1]?.trim() ?? "",
          loadAverage: batch.outputs.loadavg.trim(),
          uptime: batch.outputs.uptime.trim()
        })
      };
    }
  );

  destructiveTool(
    server,
    "server_reboot",
    "Reboot host",
    "Reboot the managed host through systemd.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runSsh(host, systemctlActionCommand("reboot"));
      return {
        content: jsonText(result)
      };
    }
  );
}
