import path from "node:path";
import { z } from "zod";
import {
  joinShellCommand,
  jsonText,
  parseDelimitedRows,
  parseLines,
  readonlyTool,
  destructiveTool,
  remoteCommandInDir,
  safeComposeProjectPath,
  shellQuote,
  scrubSensitiveValues
} from "../helpers.js";
import type { Deps } from "./deps.js";

const COMPOSE_FILE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

type ProjectEntry = {
  name: string;
  path: string;
  files: string[];
  containers: string[];
  services: string[];
  images: string[];
  sources: string[];
  mode: "compose-file" | "docker-label";
};

type ResolvedProject = ProjectEntry & {
  requested: string;
  hasComposeFile: boolean;
};

function assertSafeComposeProjectName(project: string): void {
  if (!/^[A-Za-z0-9_.@:-]+$/.test(project)) {
    throw new Error("Invalid compose project name. Use a Docker Compose project name or directory name.");
  }
}

function assertAllowedComposeProject(config: any, project: ResolvedProject): void {
  if (
    config.allowedComposeProjects.length > 0 &&
    !config.allowedComposeProjects.includes(project.requested) &&
    !config.allowedComposeProjects.includes(project.name) &&
    !config.allowedComposeProjects.includes(path.posix.basename(project.path))
  ) {
    throw new Error(
      `Compose project '${project.requested}' not in whitelist. Allowed: ${
        config.allowedComposeProjects.join(", ") || "(none)"
      }`
    );
  }
}

function dockerLabelFilter(project: ResolvedProject): string[] {
  return ["--filter", `label=com.docker.compose.project=${project.name}`];
}

function dockerLabelServiceFilter(project: ResolvedProject, service?: string): string[] {
  return service
    ? [...dockerLabelFilter(project), "--filter", `label=com.docker.compose.service=${service}`]
    : dockerLabelFilter(project);
}

function redactComposeConfigOutput(value: string): string {
  const sensitiveKeyLine = /^(\s*(?:-\s*)?(?:CLOUDFLARED_TOKEN|HALO_DB_PASSWORD|POSTGRES_PASSWORD|MYSQL_ROOT_PASSWORD|MYSQL_PASSWORD|PASSWORD|TOKEN|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|.*(?:token|password|secret|credential|api.?key|access.?key|private.?key).*)\s*:\s*).+$/i;
  const sensitiveAssignmentLine = /^(\s*-\s*(?:[^=\s]*(?:token|password|secret|credential|api.?key|access.?key|private.?key)[^=\s]*)=).+$/i;
  const sensitiveCommandAssignment = /(password|token|secret|credential|api.?key|access.?key|private.?key)=([^'"`\s]+)/gi;

  return value
    .split(/\r?\n/)
    .map((line) => {
      if (sensitiveKeyLine.test(line)) {
        return line.replace(sensitiveKeyLine, "$1[redacted]");
      }
      if (sensitiveAssignmentLine.test(line)) {
        return line.replace(sensitiveAssignmentLine, "$1[redacted]");
      }
      return line.replace(sensitiveCommandAssignment, "$1=[redacted]");
    })
    .join("\n");
}

function projectMatches(project: ProjectEntry, requested: string, composeRoot: string): boolean {
  const relativePath = project.path.startsWith(`${composeRoot.replace(/\/+$/, "")}/`)
    ? project.path.slice(composeRoot.replace(/\/+$/, "").length + 1)
    : project.path;
  return (
    project.name === requested ||
    project.path === requested ||
    path.posix.basename(project.path) === requested ||
    relativePath === requested
  );
}

async function collectComposeProjects(
  host: ReturnType<Deps["assertAllowedHost"]>,
  config: Deps["config"],
  ssh: Deps["ssh"]
): Promise<{
  projects: ProjectEntry[];
  directoryScan: { stderr: string; code: number | null };
  containerScan: { stderr: string; code: number | null };
}> {
  const composeRoot = config.composeRoot.replace(/\/+$/, "");
  const [directoryResult, containerResult] = await Promise.all([
    ssh.runSsh(
      host,
      remoteCommandInDir(
        composeRoot,
        "find . -maxdepth 4 -type f \\( -name 'docker-compose.yml' -o -name 'docker-compose.yaml' -o -name 'compose.yml' -o -name 'compose.yaml' \\) -printf '%h|%f\\n' 2>/dev/null | sort -u"
      )
    ),
    ssh.runDocker(host, [
      "ps",
      "--all",
      "--format",
      "{{.Names}}|{{.Image}}|{{.Label \"com.docker.compose.project\"}}|{{.Label \"com.docker.compose.project.working_dir\"}}|{{.Label \"com.docker.compose.project.config_files\"}}|{{.Label \"com.docker.compose.service\"}}"
    ])
  ]);

  const projects = new Map<string, ProjectEntry>();

  for (const line of parseLines(directoryResult.stdout)) {
    const [projectPath, fileName] = line.split("|");
    const cleanPath = projectPath.replace(/^\.\//, "");
    const absolutePath = path.posix.join(composeRoot, cleanPath);
    const key = `path:${absolutePath}`;
    const current = projects.get(key) ?? {
      name: path.posix.basename(cleanPath),
      path: absolutePath,
      files: [],
      containers: [],
      services: [],
      images: [],
      sources: [],
      mode: "compose-file" as const
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
    const [containerName, image, projectName, workingDir, configFiles, serviceName] = line.split("|");
    if (!projectName) {
      continue;
    }
    const firstConfig = (configFiles ?? "").split(",")[0]?.trim();
    const projectPath = workingDir?.trim() || (firstConfig ? path.posix.dirname(firstConfig) : path.posix.join(composeRoot, projectName));
    const key = `project:${projectName}`;
    const existingByPath = Array.from(projects.values()).find((item) => item.path === projectPath);
    const current = projects.get(key) ?? existingByPath ?? {
      name: projectName,
      path: projectPath,
      files: [],
      containers: [],
      services: [],
      images: [],
      sources: [],
      mode: "docker-label" as const
    };
    current.name = projectName;
    current.path = projectPath;
    if (containerName && !current.containers.includes(containerName)) {
      current.containers.push(containerName);
    }
    if (image && !current.images.includes(image)) {
      current.images.push(image);
    }
    if (serviceName && !current.services.includes(serviceName)) {
      current.services.push(serviceName);
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
    projects: Array.from(projects.values()).sort((left, right) => left.name.localeCompare(right.name)),
    directoryScan: {
      stderr: directoryResult.stderr.trim(),
      code: directoryResult.code
    },
    containerScan: {
      stderr: containerResult.stderr.trim(),
      code: containerResult.code
    }
  };
}

async function hasReadableComposeFile(
  host: ReturnType<Deps["assertAllowedHost"]>,
  ssh: Deps["ssh"],
  project: ProjectEntry
): Promise<boolean> {
  const checks = COMPOSE_FILE_NAMES.map((file) => `[ -f ${shellQuote(path.posix.join(project.path, file))} ]`).join(" || ");
  const result = await ssh.runSsh(host, checks);
  return result.code === 0;
}

async function resolveComposeProject(
  host: ReturnType<Deps["assertAllowedHost"]>,
  config: Deps["config"],
  ssh: Deps["ssh"],
  requested: string
): Promise<ResolvedProject> {
  assertSafeComposeProjectName(requested);
  const discovered = await collectComposeProjects(host, config, ssh);
  const match = discovered.projects.find((project) => projectMatches(project, requested, config.composeRoot));
  const fallbackPath = safeComposeProjectPath(config.composeRoot, requested);
  const project = match ?? {
    name: requested,
    path: fallbackPath,
    files: [],
    containers: [],
    services: [],
    images: [],
    sources: [],
    mode: "compose-file" as const
  };
  const hasComposeFile = await hasReadableComposeFile(host, ssh, project);
  return {
    ...project,
    requested,
    hasComposeFile,
    mode: hasComposeFile ? "compose-file" : "docker-label"
  };
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
      const discovery = await collectComposeProjects(host, config, ssh);
      const projects = await Promise.all(
        discovery.projects.map(async (project) => ({
          ...project,
          mode: (await hasReadableComposeFile(host, ssh, project)) ? "compose-file" : "docker-label"
        }))
      );

      return {
        content: jsonText({
          host: host.host,
          composeRoot: config.composeRoot,
          projects,
          directoryScan: discovery.directoryScan,
          containerScan: discovery.containerScan
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
      const resolved = await resolveComposeProject(host, config, ssh, project);
      if (!resolved.hasComposeFile) {
        return {
          content: jsonText({
            host: host.host,
            project,
            resolvedProject: resolved.name,
            path: resolved.path,
            mode: resolved.mode,
            stdout: "",
            stderr:
              "No readable compose file was found. This appears to be a Portainer-managed stack; inspect the stack in Portainer or use docker-label fallback tools.",
            code: 1
          })
        };
      }
      const result = await ssh.runSsh(host, remoteCommandInDir(resolved.path, "docker compose config"));
      return {
        content: jsonText(scrubSensitiveValues({
          host: host.host,
          project,
          resolvedProject: resolved.name,
          path: resolved.path,
          mode: resolved.mode,
          stdout: redactComposeConfigOutput(result.stdout.trim()),
          stderr: result.stderr.trim(),
          code: result.code
        }))
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
      const resolved = await resolveComposeProject(host, config, ssh, project);
      const result = resolved.hasComposeFile
        ? await ssh.runSsh(
            host,
            remoteCommandInDir(resolved.path, `docker compose ps ${all ? "--all " : ""}--format json`)
          )
        : await ssh.runDocker(host, [
            "ps",
            ...(all ? ["--all"] : []),
            ...dockerLabelFilter(resolved),
            "--format",
            "{{.ID}}|{{.Image}}|{{.Names}}|{{.Status}}|{{.Ports}}"
          ]);
      return {
        content: jsonText({
          host: host.host,
          project,
          resolvedProject: resolved.name,
          path: resolved.path,
          mode: resolved.mode,
          containers: resolved.hasComposeFile
            ? null
            : parseDelimitedRows(result.stdout, ["id", "image", "name", "status", "ports"]),
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
      const resolved = await resolveComposeProject(host, config, ssh, project);
      const result = resolved.hasComposeFile
        ? await ssh.runSsh(
            host,
            remoteCommandInDir(
              resolved.path,
              joinShellCommand([
                "docker",
                "compose",
                "logs",
                "--tail",
                String(tail),
                "--timestamps",
                ...(service ? [service] : [])
              ])
            )
          )
        : await ssh.runSsh(
            host,
            [
              `containers=$(docker ps -a ${dockerLabelServiceFilter(resolved, service)
                .map(shellQuote)
                .join(" ")} --format '{{.Names}}')`,
              'if [ -z "$containers" ]; then echo "No containers matched compose project labels." >&2; exit 1; fi',
              'for container in $containers; do echo "==> $container <=="; docker logs --tail ' +
                shellQuote(String(tail)) +
                " --timestamps \"$container\"; done"
            ].join("; ")
          );
      return {
        content: jsonText({
          host: host.host,
          project,
          resolvedProject: resolved.name,
          service: service ?? null,
          path: resolved.path,
          mode: resolved.mode,
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
      const host = assertAllowedHost(hostId);
      const resolved = await resolveComposeProject(host, config, ssh, project);
      assertAllowedComposeProject(config, resolved);
      const result = resolved.hasComposeFile
        ? await ssh.runSsh(host, remoteCommandInDir(resolved.path, "docker compose pull"))
        : await ssh.runSsh(
            host,
            [
              `images=$(docker ps -a ${dockerLabelFilter(resolved)
                .map(shellQuote)
                .join(" ")} --format '{{.Image}}' | sort -u)`,
              'if [ -z "$images" ]; then echo "No containers matched compose project labels." >&2; exit 1; fi',
              'for image in $images; do echo "==> docker pull $image <=="; docker pull "$image"; done'
            ].join("; ")
          );
      return {
        content: jsonText({
          host: host.host,
          project,
          resolvedProject: resolved.name,
          path: resolved.path,
          mode: resolved.mode,
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
      const host = assertAllowedHost(hostId);
      const resolved = await resolveComposeProject(host, config, ssh, project);
      assertAllowedComposeProject(config, resolved);
      const result = resolved.hasComposeFile
        ? await ssh.runSsh(host, remoteCommandInDir(resolved.path, "docker compose up -d"))
        : await ssh.runSsh(
            host,
            [
              `containers=$(docker ps -a ${dockerLabelFilter(resolved)
                .map(shellQuote)
                .join(" ")} --format '{{.Names}}')`,
              'if [ -z "$containers" ]; then echo "No containers matched compose project labels." >&2; exit 1; fi',
              'for container in $containers; do docker start "$container"; done',
              'echo "Portainer label fallback started matching containers. It does not recreate containers from a changed image."'
            ].join("; ")
          );
      return {
        content: jsonText({
          host: host.host,
          project,
          resolvedProject: resolved.name,
          path: resolved.path,
          mode: resolved.mode,
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
      const host = assertAllowedHost(hostId);
      const resolved = await resolveComposeProject(host, config, ssh, project);
      assertAllowedComposeProject(config, resolved);
      const result = resolved.hasComposeFile
        ? await ssh.runSsh(host, remoteCommandInDir(resolved.path, "docker compose down"))
        : await ssh.runSsh(
            host,
            [
              `containers=$(docker ps -a ${dockerLabelFilter(resolved)
                .map(shellQuote)
                .join(" ")} --format '{{.Names}}')`,
              'if [ -z "$containers" ]; then echo "No containers matched compose project labels." >&2; exit 1; fi',
              'for container in $containers; do docker stop "$container"; done',
              'echo "Portainer label fallback stopped matching containers. It does not remove Portainer stack networks or definitions."'
            ].join("; ")
          );
      return {
        content: jsonText({
          host: host.host,
          project,
          resolvedProject: resolved.name,
          path: resolved.path,
          mode: resolved.mode,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    }
  );

  destructiveTool(
    server,
    "compose_update",
    "Update compose project",
    "Pull images and recreate containers for a Compose or Portainer-managed project.",
    {
      hostId: z.string(),
      project: z.string()
    },
    async ({ hostId, project }) => {
      const host = assertAllowedHost(hostId);
      const resolved = await resolveComposeProject(host, config, ssh, project);
      assertAllowedComposeProject(config, resolved);
      const result = resolved.hasComposeFile
        ? await ssh.runSsh(host, remoteCommandInDir(resolved.path, "docker compose pull && docker compose up -d"))
        : await ssh.runSsh(
            host,
            [
              `containers=$(docker ps -a ${dockerLabelFilter(resolved)
                .map(shellQuote)
                .join(" ")} --format '{{.Names}}')`,
              'if [ -z "$containers" ]; then echo "No containers matched compose project labels." >&2; exit 1; fi',
              'docker run --rm -e DOCKER_API_VERSION=1.40 -v /var/run/docker.sock:/var/run/docker.sock containrrr/watchtower:latest --run-once --cleanup $containers'
            ].join("; "),
            900000
          );
      return {
        content: jsonText({
          host: host.host,
          project,
          resolvedProject: resolved.name,
          path: resolved.path,
          mode: resolved.mode,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          code: result.code
        })
      };
    },
    { openWorld: true }
  );
}
