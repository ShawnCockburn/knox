import { parseArgs } from "@std/cli";
import { resolve } from "@std/path";
import { Knox } from "./knox.ts";
import { formatSummary } from "./cli/format.ts";
import { log } from "./log.ts";

const flags = parseArgs(Deno.args, {
  string: [
    "task",
    "dir",
    "model",
    "setup",
    "prompt",
    "check",
    "max-loops",
    "cpu",
    "memory",
  ],
  boolean: ["verbose", "quiet"],
  collect: ["env"],
  default: { dir: ".", model: "sonnet", "max-loops": "10" },
});

if (flags.verbose && flags.quiet) {
  console.error("Error: --verbose and --quiet are mutually exclusive");
  Deno.exit(2);
}

if (flags.verbose) {
  log.setLevel("debug");
} else if (flags.quiet) {
  log.setLevel("warn");
}

if (!flags.task) {
  console.error(
    `Usage: knox --task <task> [options]

Options:
  --task <task>       Task description (required)
  --dir <dir>         Source directory (default: .)
  --model <model>     Claude model (default: sonnet)
  --setup <cmd>       Setup command to run with network (e.g., "npm install")
  --check <cmd>       Verification command (e.g., "npm test")
  --max-loops <n>     Maximum loop iterations (default: 10)
  --env KEY=VALUE     Environment variable (repeatable)
  --prompt <path>     Custom prompt file
  --cpu <limit>       CPU limit (e.g., "2")
  --memory <limit>    Memory limit (e.g., "4g")
  --verbose           Show debug-level messages
  --quiet             Suppress info messages (show warnings and errors only)`,
  );
  Deno.exit(2);
}

const maxLoops = parseInt(flags["max-loops"] as string, 10);
if (isNaN(maxLoops) || maxLoops < 1) {
  console.error("Error: --max-loops must be a positive integer");
  Deno.exit(2);
}

// Validate --env format
const envVars = (flags.env as string[] | undefined) ?? [];
for (const e of envVars) {
  if (!e.includes("=")) {
    console.error(`Error: --env value must be in KEY=VALUE format, got: ${e}`);
    Deno.exit(2);
  }
}

try {
  const knox = new Knox({
    task: flags.task as string,
    dir: resolve(flags.dir as string),
    model: flags.model as string,
    maxLoops,
    setup: flags.setup as string | undefined,
    check: flags.check as string | undefined,
    env: envVars,
    promptPath: flags.prompt as string | undefined,
    cpuLimit: flags.cpu as string | undefined,
    memoryLimit: flags.memory as string | undefined,
    onLine: (line) => console.log(line),
  });

  const result = await knox.run();
  log.always(formatSummary(result));

  if (!result.completed) {
    Deno.exit(1);
  }
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  log.error(`Fatal: ${msg}`);
  // Exit code 2 for preflight failures, 3 for crashes
  if (msg.includes("Preflight checks failed")) {
    Deno.exit(2);
  }
  Deno.exit(3);
}
