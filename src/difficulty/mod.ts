export const DIFFICULTIES = ["complex", "balanced", "easy"] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];

export type DifficultyMap = { [K in Difficulty]: string };

export type ResolveDifficulty = (difficulty: Difficulty) => string;

export const claudeCodeDifficultyMap = {
  complex: "opus",
  balanced: "sonnet",
  easy: "haiku",
} satisfies DifficultyMap;

export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === "string" &&
    (DIFFICULTIES as readonly string[]).includes(value);
}

export function resolveDifficulty(
  difficulty: Difficulty,
  map: DifficultyMap,
): string {
  return map[difficulty];
}

export function createDifficultyResolver(map: DifficultyMap): ResolveDifficulty {
  return (difficulty) => resolveDifficulty(difficulty, map);
}
