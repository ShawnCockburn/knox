import knoxPlanSkill from "../../../.agents/skills/knox-plan/SKILL.md" with {
  type: "text",
};
import knoxAddTaskSkill from "../../../.agents/skills/knox-add-task/SKILL.md" with {
  type: "text",
};
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { isProviderId } from "../../provider/provider_id.ts";
import type { ProviderId } from "../../provider/provider_id.ts";

const GITIGNORE_BLOCK = "\n# Knox\n.knox/*\n!.knox/config.yaml\n";

export interface RunInitOptions {
  provider?: string;
}

export async function runInit(options: RunInitOptions = {}): Promise<void> {
  const repoRoot = await findGitRoot();
  await initKnoxDir(repoRoot);
  await writeProjectConfig(repoRoot, options.provider);
  await installSkills(repoRoot);
  await updateGitignore(repoRoot);
}

async function findGitRoot(): Promise<string> {
  const result = await new Deno.Command("git", {
    args: ["rev-parse", "--show-toplevel"],
    stdout: "piped",
    stderr: "null",
  }).output();

  if (!result.success) {
    console.error("Error: not inside a git repository.");
    Deno.exit(2);
  }

  return new TextDecoder().decode(result.stdout).trim();
}

async function initKnoxDir(repoRoot: string): Promise<void> {
  const knoxDir = join(repoRoot, ".knox");
  const existed = await pathExists(knoxDir);
  await ensureDir(knoxDir);
  if (!existed) {
    console.log("created  .knox/");
  }
}

async function writeProjectConfig(
  repoRoot: string,
  cliProvider?: string,
): Promise<void> {
  const provider = await resolvePreferredProvider(cliProvider);
  const configPath = join(repoRoot, ".knox", "config.yaml");
  let config: Record<string, unknown> = {};
  let existed = false;

  try {
    const text = await Deno.readTextFile(configPath);
    const parsed = parseYaml(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
    existed = true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  config.provider = provider;
  await Deno.writeTextFile(configPath, stringifyYaml(config));
  console.log(
    `${(existed ? "updated" : "created").padEnd(8)} .knox/config.yaml`,
  );
}

async function resolvePreferredProvider(
  cliProvider?: string,
): Promise<ProviderId> {
  if (cliProvider !== undefined) {
    if (!isProviderId(cliProvider)) {
      console.error(
        `Error: --provider must be one of: claude, codex. Got '${cliProvider}'.`,
      );
      Deno.exit(2);
    }
    return cliProvider;
  }

  const answer = prompt("Preferred Knox provider (claude/codex)?", "claude");
  if (!answer) {
    console.error(
      "Error: provider selection is required. Re-run with --provider claude|codex.",
    );
    Deno.exit(2);
  }

  const provider = answer.trim().toLowerCase();
  if (!isProviderId(provider)) {
    console.error(
      `Error: provider must be one of: claude, codex. Got '${answer}'.`,
    );
    Deno.exit(2);
  }

  return provider;
}

async function installSkills(repoRoot: string): Promise<void> {
  const skills: [string, string][] = [
    ["knox-plan", knoxPlanSkill],
    ["knox-add-task", knoxAddTaskSkill],
  ];

  for (const [name, content] of skills) {
    await installSkill(repoRoot, ".agents", name, content);
    await installSkill(repoRoot, ".claude", name, content);
  }
}

async function installSkill(
  repoRoot: string,
  agentDir: ".agents" | ".claude",
  name: string,
  content: string,
): Promise<void> {
  const skillDir = join(repoRoot, agentDir, "skills", name);
  const skillPath = join(skillDir, "SKILL.md");
  const existed = await pathExists(skillPath);

  await ensureDir(skillDir);
  await Deno.writeTextFile(skillPath, content);

  if (existed) {
    console.warn(`warning  ${agentDir}/skills/${name}/SKILL.md overwritten`);
  } else {
    console.log(`created  ${agentDir}/skills/${name}/SKILL.md`);
  }
}

async function updateGitignore(repoRoot: string): Promise<void> {
  const gitignorePath = join(repoRoot, ".gitignore");
  let existing = "";
  let gitignoreExisted = false;

  try {
    existing = await Deno.readTextFile(gitignorePath);
    gitignoreExisted = true;
  } catch {
    // will create
  }

  if (existing.includes(".knox/*")) {
    return;
  }

  await Deno.writeTextFile(gitignorePath, existing + GITIGNORE_BLOCK);
  const action = gitignoreExisted ? "updated" : "created";
  console.log(`${action.padEnd(8)} .gitignore`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
