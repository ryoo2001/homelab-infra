import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Client, type ConnectConfig } from "ssh2";
import type { AppConfig, HostConfig } from "./config.js";
import { dockerShellCommand, joinShellCommand, shellQuote } from "./helpers.js";

export type SshResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  truncated?: boolean;
};

export type BatchStep = {
  name: string;
  command: string;
};

export type BatchResult = {
  outputs: Record<string, string>;
  stderr: string;
  code: number | null;
  truncated?: boolean;
};

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB

export type SshExecutor = {
  runSsh(target: HostConfig, command: string | string[], timeoutMs?: number): Promise<SshResult>;
  runDocker(target: HostConfig, args: string[], timeoutMs?: number): Promise<SshResult>;
  runBatch(target: HostConfig, steps: BatchStep[], timeoutMs?: number): Promise<BatchResult>;
};

export function createSshExecutor(config: AppConfig): SshExecutor {
  async function sshConnectionConfig(target: HostConfig): Promise<ConnectConfig> {
    const user = target.user ?? config.sshUser;
    const connection: ConnectConfig = {
      host: target.host,
      username: user,
      port: target.port ?? config.sshPort,
      readyTimeout: config.sshConnectTimeoutMs
    };
    if (config.sshPassword) {
      connection.password = config.sshPassword;
    }
    if (config.sshKeyPath) {
      connection.privateKey = await readFile(config.sshKeyPath);
    }
    return connection;
  }

  function runSsh(
    target: HostConfig,
    command: string | string[],
    timeoutMs = config.sshCommandTimeoutMs
  ): Promise<SshResult> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        action();
      };
      const timer = setTimeout(() => {
        client.end();
        settle(() => reject(new Error(`SSH command timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      client.on("ready", () => {
        const execCommand = Array.isArray(command) ? command.join(" ") : command;
        client.exec(execCommand, (error, stream) => {
          if (error) {
            client.end();
            settle(() => reject(error));
            return;
          }

          stream.on("data", (chunk: Buffer) => {
            if (!stdoutTruncated && stdout.length + chunk.length > MAX_OUTPUT_BYTES) {
              stdout += chunk.toString().slice(0, MAX_OUTPUT_BYTES - stdout.length);
              stdoutTruncated = true;
            } else if (!stdoutTruncated) {
              stdout += chunk.toString();
            }
          });
          stream.stderr.on("data", (chunk: Buffer) => {
            if (!stderrTruncated && stderr.length + chunk.length > MAX_OUTPUT_BYTES) {
              stderr += chunk.toString().slice(0, MAX_OUTPUT_BYTES - stderr.length);
              stderrTruncated = true;
            } else if (!stderrTruncated) {
              stderr += chunk.toString();
            }
          });
          stream.on("close", (code: number | null) => {
            client.end();
            settle(() =>
              resolve({
                stdout,
                stderr,
                code,
                ...(stdoutTruncated || stderrTruncated ? { truncated: true } : {})
              })
            );
          });
        });
      });

      client.on("error", (error: Error) => {
        settle(() => reject(error));
      });

      void sshConnectionConfig(target)
        .then((connection) => client.connect(connection))
        .catch((error: Error) => settle(() => reject(error)));
    });
  }

  function runDocker(target: HostConfig, args: string[], timeoutMs = config.sshCommandTimeoutMs) {
    return runSsh(target, dockerShellCommand(args), timeoutMs);
  }

  async function runBatch(
    target: HostConfig,
    steps: BatchStep[],
    timeoutMs?: number
  ): Promise<BatchResult> {
    const marker = `__MCP_${randomBytes(8).toString("hex")}__`;
    const wrapped = steps
      .map((step) => `printf '%s\\n' ${shellQuote(`${marker}:${step.name}`)}\n${step.command}`)
      .join("\n");
    const command = joinShellCommand(["sh", "-lc", wrapped]);
    const result = await runSsh(target, command, timeoutMs);

    const outputs: Record<string, string> = {};
    for (const step of steps) {
      outputs[step.name] = "";
    }
    if (result.stdout) {
      const buffers: Record<string, string[]> = {};
      let current: string | null = null;
      for (const line of result.stdout.split(/\r?\n/)) {
        if (line.startsWith(`${marker}:`)) {
          current = line.slice(marker.length + 1);
          if (!buffers[current]) {
            buffers[current] = [];
          }
          continue;
        }
        if (current) {
          buffers[current].push(line);
        }
      }
      for (const [name, lines] of Object.entries(buffers)) {
        while (lines.length > 0 && lines[lines.length - 1] === "") {
          lines.pop();
        }
        outputs[name] = lines.join("\n");
      }
    }

    return {
      outputs,
      stderr: result.stderr,
      code: result.code,
      ...(result.truncated ? { truncated: true } : {})
    };
  }

  return { runSsh, runDocker, runBatch };
}
