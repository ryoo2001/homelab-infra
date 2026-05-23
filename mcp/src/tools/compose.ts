import path from "node:path";
import { z } from "zod";
import {
  joinShellCommand,
  jsonText,
  parseLines,
  readonlyTool,
  destructiveTool,
  remoteCommandInDir,
  safeComposeProjectPath
} from "../helpers.js";
import type { Deps } from "./deps.js";

function assertAllowedComposeProject(config: any, project: string): void {
  if (config.allowedComposeProjects.length > 0 && !config.allowedComposeProjects.includes(project)) {
    throw new Error(
      `Compose project '${project}' not in whitelist. Allowed: ${config.allowedComposeProjects.join(", ") || "(none)"}`
    );
  }
}

export function registerComposeTools({ server, config, ssh, assertAllowedHost }: Deps): void {
  readonlyTool(
    server,
    "compose_projects",
    "List compose projects",
    "Discover Docker Compose project directories under the configured compose root.",
    { hostId: z.string() },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const [directoryResult, containerResult] = await Promise.all([
        ssh.runSsh(
          host,
          remoteCommandInDir(
            config.composeRoot,
            "find . -maxdepth 4 -type f \\( -name 'docker-compose.yml' -o -name 'docker-compose.yaml' -o -name 'compose.yml' -o -name 'compose.yaml' \\) -printf '%h|%f\\n' 2>/dev/null | sort -u"
          )
        ),
        ssh.runDocker(host, [
          "ps",
          "--all",
          "--format",
          "{{.Names}}|{{.Label \"com.docker.compose.project\"}}|{{.Label \"com.docker.compose.project.config_files\"}}"
        ])
      ]);

      type ProjectEntry = {
        name: string;
        path: string;
        files: string[];
        containers: string[];
        sources: string[];
      };
      const projects = new Map<string, ProjectEntry>();

      for (const line of parseLines(directoryResult.stdout)) {
        const [projectPath, fileName] = line.split("|");
        const cleanPath = projectPath.replace(/^\.\//, "");
        const key = cleanPath;
        const current = projects.get(key) ?? {
          name: path.posix.basename(cleanPath),
          path: cleanPath,
          files: [],
          containers: [],
          sources: []
        };
        if (fileName && !current.files.includes(fileName)) {
          current.files.push(fileName);
        }
        if (!current.sources.includes("directory")) {
          current.sources.push("directory");
        }
        projects.set(key, current);
      }

      for (const line of parseLines(containerResult.stdout)) {
        const [containerName, projectName, configFiles] = line.split("|");
        if (!projectName) {
          continue;
        }
        const firstConfig = (configFiles ?? "").split(",")[0]?.trim();
        const projectPath = firstConfig
          ? path.posix.dirname(firstConfig)
          : path.posix.join(config.composeRoot, projectName);
        const key = projectPath;
        const current = projects.get(key) ?? {
          name: projectName,
          path: projectPath,
          files: [],
          containers: [],
          sources: []
        };
        if (!current.containers.includes(containerName)) {
          current.containers.push(containerName);
        }
        if (firstConfig) {
          const fileName = path.posix.basename(firstConfig);
          if (!current.files.includes(fileName)) {
            current.files.push(fileName);
          }
        }
        if (!current.sources.includes("docker")) {
          current.sources.push("docker");
        }
        projects.set(key, current);
      }

      return {
        content: jsonText({
          host: host.host,
          composeRoot: config.composeRoot,
          projects: Array.from(projects.values()).sort((left, right) =>
            left.name.localeCompare(right.name)
          ),
          directoryScan: {
            stderr: directoryResult.stderr.trim(),
            code: directoryResult.code
          },
          containerScan: {
            stderr: containerResult.stderr.trim(),
            code: containerResult.code
          }
        })
      };
    }
  );

  readonlyTool(
    server,
    "compose_config",
    "Validate compose config",
    "Run docker compose config for a project directory under COMPOSE_ROOT.",
    {
      hostId: z.string(),
      project: z.string()
    },
    async ({ hostId, project }) => {
      const host = assertAllowedHost(hostId);
      const projectPath = safeComposeProjectPath(config.composeRoot, project);
      const result = await ssh.runSsh(host, remoteCommandInDir(projectPath, "docker compose config"));
      return {
        content: jsonText({
          host: host.host,
          project,
          path: projectPath,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "compose_ps",
    "List compose project containers",
    "Run docker compose ps for a project directory under COMPOSE_ROOT.",
    {
      hostId: z.string(),
      project: z.string(),
      all: z.boolean().default(false)
    },
    async ({ hostId, project, all }) => {
      const host = assertAllowedHost(hostId);
      const projectPath = safeComposeProjectPath(config.composeRoot, project);
      const result = await ssh.runSsh(
        host,
        remoteCommandInDir(projectPath, `docker compose ps ${all ? "--all " : ""}--format json`)
      );
      return {
        content: jsonText({
          host: host.host,
          project,
          path: projectPath,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  readonlyTool(
    server,
    "compose_logs",
    "Fetch compose logs",
    "Fetch recent logs from a Docker Compose project.",
    {
      hostId: z.string(),
      project: z.string(),
      service: z.string().optional(),
      tail: z.number().int().positive().max(1000).default(200)
    },
    async ({ hostId, project, service, tail }) => {
      const host = assertAllowedHost(hostId);
      const projectPath = safeComposeProjectPath(config.composeRoot, project);
      const command = ["docker", "compose", "logs", "--tail", String(tail), "--timestamps"];
      if (service) {
        command.push(service);
      }
      const result = await ssh.runSsh(host, remoteCommandInDir(projectPath, joinShellCommand(command)));
      return {
        content: jsonText({
          host: host.host,
          project,
          service: service ?? null,
          path: projectPath,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  destructiveTool(
    server,
    "compose_pull",
    "Pull compose images",
    "Pull images for a Docker Compose project.",
    {
      hostId: z.string(),
      project: z.string()
    },
    async ({ hostId, project }) => {
      assertAllowedComposeProject(config, project);
      const host = assertAllowedHost(hostId);
      const projectPath = safeComposeProjectPath(config.composeRoot, project);
      const result = await ssh.runSsh(host, remoteCommandInDir(projectPath, "docker compose pull"));
      return {
        content: jsonText({
          host: host.host,
          project,
          path: projectPath,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    },
    { openWorld: true }
  );

  destructiveTool(
    server,
    "compose_up",
    "Start compose project",
    "Run docker compose up -d for a project under COMPOSE_ROOT.",
    {
      hostId: z.string(),
      project: z.string()
    },
    async ({ hostId, project }) => {
      assertAllowedComposeProject(config, project);
      const host = assertAllowedHost(hostId);
      const projectPath = safeComposeProjectPath(config.composeRoot, project);
      const result = await ssh.runSsh(host, remoteCommandInDir(projectPath, "docker compose up -d"));
      return {
        content: jsonText({
          host: host.host,
          project,
          path: projectPath,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  destructiveTool(
    server,
    "compose_down",
    "Stop compose project",
    "Run docker compose down for a project under COMPOSE_ROOT.",
    {
      hostId: z.string(),
      project: z.string()
    },
    async ({ hostId, project }) => {
      assertAllowedComposeProject(config, project);
      const host = assertAllowedHost(hostId);
      const projectPath = safeComposeProjectPath(config.composeRoot, project);
      const result = await ssh.runSsh(host, remoteCommandInDir(projectPath, "docker compose down"));
      return {
        content: jsonText({
          host: host.host,
          project,
          path: projectPath,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );
}
