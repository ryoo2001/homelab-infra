import { z } from "zod";
import { jsonText, parseDelimitedRows, readonlyTool, destructiveTool } from "../helpers.js";
import type { Deps } from "./deps.js";

export function registerDockerTools({ server, ssh, assertAllowedHost }: Deps): void {
  readonlyTool(
    server,
    "docker_info",
    "Get Docker info",
    "Return Docker daemon and client information.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runDocker(host, ["info", "--format", "{{json .}}"]);
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
    "docker_system_df",
    "Get Docker disk usage",
    "Return Docker disk usage summary.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runDocker(host, ["system", "df", "--format", "{{json .}}"]);
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
    "docker_ps",
    "List Docker containers",
    "List containers with optional inclusion of stopped containers.",
    {
      hostId: z.string(),
      all: z.boolean().default(false)
    },
    async ({ hostId, all }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runDocker(host, [
        "ps",
        ...(all ? ["--all"] : []),
        "--format",
        "{{.ID}}|{{.Image}}|{{.Names}}|{{.Status}}|{{.Ports}}"
      ]);
      return {
        content: jsonText({
          host: host.host,
          all,
          containers: parseDelimitedRows(result.stdout, ["id", "image", "name", "status", "ports"]),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "docker_stats",
    "List Docker stats",
    "Return a snapshot of container CPU, memory, network, and block I/O usage.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runDocker(host, [
        "stats",
        "--no-stream",
        "--format",
        "{{.Container}}|{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.BlockIO}}|{{.PIDs}}"
      ]);
      return {
        content: jsonText({
          host: host.host,
          containers: parseDelimitedRows(result.stdout, ["id", "name", "cpu", "memory", "netIo", "blockIo", "pids"]),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "docker_images",
    "List Docker images",
    "List local Docker images.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runDocker(host, [
        "images",
        "--format",
        "{{.Repository}}|{{.Tag}}|{{.ID}}|{{.Size}}"
      ]);
      return {
        content: jsonText({
          host: host.host,
          images: parseDelimitedRows(result.stdout, ["repository", "tag", "id", "size"]),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "docker_networks",
    "List Docker networks",
    "List Docker networks on the host.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runDocker(host, [
        "network",
        "ls",
        "--format",
        "{{.ID}}|{{.Name}}|{{.Driver}}|{{.Scope}}"
      ]);
      return {
        content: jsonText({
          host: host.host,
          networks: parseDelimitedRows(result.stdout, ["id", "name", "driver", "scope"]),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "docker_volumes",
    "List Docker volumes",
    "List Docker volumes on the host.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runDocker(host, [
        "volume",
        "ls",
        "--format",
        "{{.Name}}|{{.Driver}}"
      ]);
      return {
        content: jsonText({
          host: host.host,
          volumes: parseDelimitedRows(result.stdout, ["name", "driver"]),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "docker_compose_version",
    "Get Compose version",
    "Return the Docker Compose plugin version on the host.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runDocker(host, ["compose", "version"]);
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
    "docker_logs",
    "Fetch container logs",
    "Return recent logs for a Docker container.",
    {
      hostId: z.string(),
      container: z.string(),
      tail: z.number().int().positive().max(1000).default(200),
      since: z.string().optional()
    },
    async ({ hostId, container, tail, since }) => {
      const host = assertAllowedHost(hostId);
      const args = ["logs", "--tail", String(tail), "--timestamps"];
      if (since) {
        args.push("--since", since);
      }
      args.push(container);
      const result = await ssh.runDocker(host, args);
      return {
        content: jsonText({
          host: host.host,
          container,
          tail,
          since: since ?? null,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "docker_inspect",
    "Inspect Docker object",
    "Return detailed JSON inspection output for a container, image, or network.",
    {
      hostId: z.string(),
      target: z.string()
    },
    async ({ hostId, target }) => {
      const host = assertAllowedHost(hostId);
      const result = await ssh.runDocker(host, ["inspect", target]);
      let parsed: unknown = result.stdout.trim();
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        // keep raw text
      }
      return {
        content: jsonText({
          host: host.host,
          target,
          data: parsed,
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  const containerLifecycle = [
    { name: "docker_restart", title: "Restart Docker container", description: "Restart a Docker container by name or id.", action: "restart" },
    { name: "docker_start", title: "Start Docker container", description: "Start a Docker container by name or id.", action: "start" },
    { name: "docker_stop", title: "Stop Docker container", description: "Stop a Docker container by name or id.", action: "stop" }
  ];

  for (const entry of containerLifecycle) {
    destructiveTool(
      server,
      entry.name,
      entry.title,
      entry.description,
      {
        hostId: z.string(),
        container: z.string()
      },
      async ({ hostId, container }) => {
        const host = assertAllowedHost(hostId);
        const result = await ssh.runDocker(host, [entry.action, container]);
        return {
          content: jsonText(result)
        };
      }
    );
  }
}
