import knoxPlanSkill from "../../../.claude/skills/knox-plan/skill.md" with {
  type: "text",
};
import knoxAddTaskSkill from "../../../.claude/skills/knox-add-task/skill.md" with {
  type: "text",
};
import { join } from "@std/path";
import { ensureDir } from "@std/fs";

const GITIGNORE_BLOCK = "\n# Knox\n.knox/*\n!.knox/config.yaml\n";

export async function runInit(): Promise<void> {
  const repoRoot = await findGitRoot();
  await initKnoxDir(repoRoot);
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

async function installSkills(repoRoot: string): Promise<void> {
  const skills: [string, string][] = [
    ["knox-plan", knoxPlanSkill],
    ["knox-add-task", knoxAddTaskSkill],
  ];

  for (const [name, content] of skills) {
    const skillDir = join(repoRoot, ".claude", "skills", name);
    const skillPath = join(skillDir, "skill.md");
    const existed = await pathExists(skillPath);

    await ensureDir(skillDir);
    await Deno.writeTextFile(skillPath, content);

    if (existed) {
      console.warn(`warning  .claude/skills/${name}/skill.md overwritten`);
    } else {
      console.log(`created  .claude/skills/${name}/skill.md`);
    }
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
