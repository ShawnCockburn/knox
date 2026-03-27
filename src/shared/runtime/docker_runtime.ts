import { TextLineStream } from "@std/streams";
import type {
  BuildImageOptions,
  CommitOptions,
  ContainerId,
  CreateContainerOptions,
  ExecResult,
  ImageId,
} from "../types.ts";
import type {
  ContainerRuntime,
  ExecOptions,
  OnLineCallback,
} from "./container_runtime.ts";

/** ContainerRuntime implementation that shells out to the docker CLI. */
export class DockerRuntime implements ContainerRuntime {
  async buildImage(options: BuildImageOptions): Promise<ImageId> {
    const args = ["build", "-t", options.tag];
    if (options.dockerfile) {
      args.push("-f", options.dockerfile);
    }
    if (options.buildArgs) {
      for (const [key, value] of Object.entries(options.buildArgs)) {
        args.push("--build-arg", `${key}=${value}`);
      }
    }
    args.push(options.context);

    const result = await this.run(args);
    if (result.exitCode !== 0) {
      throw new Error(`docker build failed: ${result.stderr}`);
    }
    return options.tag;
  }

  async imageExists(tag: string): Promise<boolean> {
    const result = await this.run(["image", "inspect", tag]);
    return result.exitCode === 0;
  }

  async createContainer(options: CreateContainerOptions): Promise<ContainerId> {
    const name = options.name ?? `knox-${crypto.randomUUID().slice(0, 8)}`;
    const args = ["run", "-d", "--name", name];

    if (options.workdir) {
      args.push("-w", options.workdir);
    }
    for (const e of options.env ?? []) {
      args.push("-e", e);
    }
    if (options.networkEnabled === false) {
      args.push("--network", "none");
    }
    for (const cap of options.capAdd ?? []) {
      args.push("--cap-add", cap);
    }
    if (options.cpuLimit) {
      args.push("--cpus", options.cpuLimit);
    }
    if (options.memoryLimit) {
      args.push("--memory", options.memoryLimit);
    }

    args.push(options.image);
    args.push(...(options.entrypoint ?? ["sleep", "infinity"]));

    const result = await this.run(args);
    if (result.exitCode !== 0) {
      throw new Error(`docker run failed: ${result.stderr}`);
    }
    return name;
  }

  async exec(
    container: ContainerId,
    command: string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    const args = ["exec"];
    if (options?.user) {
      args.push("-u", options.user);
    }
    if (options?.workdir) {
      args.push("-w", options.workdir);
    }
    for (const e of options?.env ?? []) {
      args.push("-e", e);
    }
    args.push(container, ...command);

    return await this.run(args);
  }

  async execStream(
    container: ContainerId,
    command: string[],
    options: ExecOptions & { onLine: OnLineCallback },
  ): Promise<number> {
    // -t allocates a pseudo-TTY so the child process (claude -p) uses
    // line-buffered streaming text output instead of block-buffered JSON.
    // Trade-off: -t merges stderr into stdout and adds \r to line endings.
    const args = ["exec", "-t"];
    if (options.user) {
      args.push("-u", options.user);
    }
    if (options.workdir) {
      args.push("-w", options.workdir);
    }
    for (const e of options.env ?? []) {
      args.push("-e", e);
    }
    args.push(container, ...command);

    const cmd = new Deno.Command("docker", {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();

    const readStream = async (
      stream: ReadableStream<Uint8Array>,
      name: "stdout" | "stderr",
    ) => {
      const lines = stream
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TextLineStream());
      for await (const line of lines) {
        // Strip \r added by the PTY
        options.onLine(line.replace(/\r$/, ""), name);
      }
    };

    await Promise.all([
      readStream(child.stdout, "stdout"),
      readStream(child.stderr, "stderr"),
    ]);

    const status = await child.status;
    return status.code;
  }

  async restrictNetwork(
    container: ContainerId,
    allowedIPs: string[],
  ): Promise<void> {
    // Build an iptables script that allows only:
    // 1. Loopback traffic
    // 2. DNS (udp/tcp 53) to any resolver — Docker Desktop uses the host
    //    gateway (e.g. 192.168.65.7), not 127.0.0.11
    // 3. HTTPS (port 443) to each allowed IP
    // 4. Established/related return traffic
    // 5. Drop everything else
    const rules = [
      "iptables -F OUTPUT",
      "iptables -A OUTPUT -o lo -j ACCEPT",
      "iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT",
      "iptables -A OUTPUT -p udp --dport 53 -j ACCEPT",
      "iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT",
      ...allowedIPs.map(
        (ip) => `iptables -A OUTPUT -p tcp -d ${ip} --dport 443 -j ACCEPT`,
      ),
      "iptables -A OUTPUT -j DROP",
    ];

    const result = await this.exec(container, [
      "sh",
      "-c",
      rules.join(" && "),
    ], { user: "root" });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to restrict network: ${result.stderr}`);
    }
  }

  async copyIn(
    container: ContainerId,
    hostPath: string,
    containerPath: string,
  ): Promise<void> {
    const result = await this.run([
      "cp",
      hostPath,
      `${container}:${containerPath}`,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`docker cp (in) failed: ${result.stderr}`);
    }
  }

  async copyOut(
    container: ContainerId,
    containerPath: string,
    hostPath: string,
  ): Promise<void> {
    const result = await this.run([
      "cp",
      `${container}:${containerPath}`,
      hostPath,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`docker cp (out) failed: ${result.stderr}`);
    }
  }

  async commit(options: CommitOptions): Promise<ImageId> {
    const args = ["commit"];
    if (options.message) {
      args.push("-m", options.message);
    }
    args.push(options.container, options.tag);

    const result = await this.run(args);
    if (result.exitCode !== 0) {
      throw new Error(`docker commit failed: ${result.stderr}`);
    }
    return options.tag;
  }

  async stop(container: ContainerId): Promise<void> {
    const result = await this.run(["stop", "-t", "5", container]);
    if (result.exitCode !== 0) {
      throw new Error(`docker stop failed: ${result.stderr}`);
    }
  }

  async remove(container: ContainerId): Promise<void> {
    const result = await this.run(["rm", "-f", container]);
    if (result.exitCode !== 0) {
      throw new Error(`docker rm failed: ${result.stderr}`);
    }
  }

  async removeImagesByPrefix(prefix: string): Promise<number> {
    // List images matching the prefix
    const listResult = await this.run([
      "images",
      "--format",
      "{{.Repository}}:{{.Tag}}",
      "--filter",
      `reference=${prefix}*`,
    ]);
    if (listResult.exitCode !== 0) {
      return 0;
    }
    const images = listResult.stdout.trim().split("\n").filter((s) =>
      s.length > 0
    );
    if (images.length === 0) return 0;

    const rmResult = await this.run(["rmi", "-f", ...images]);
    if (rmResult.exitCode !== 0) {
      throw new Error(`docker rmi failed: ${rmResult.stderr}`);
    }
    return images.length;
  }

  private async run(args: string[]): Promise<ExecResult> {
    const cmd = new Deno.Command("docker", {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    return {
      exitCode: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  }
}
