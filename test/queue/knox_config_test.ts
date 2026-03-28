import { assertEquals, assertRejects } from "@std/assert";
import { resolveConfig } from "../../src/shared/knox/knox_config.ts";

async function setup(yaml: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "knox-config-test-" });
  await Deno.mkdir(`${dir}/.knox`);
  await Deno.writeTextFile(`${dir}/.knox/config.yaml`, yaml);
  return dir;
}

async function cleanup(dir: string) {
  await Deno.remove(dir, { recursive: true });
}

Deno.test("KnoxConfig", async (t) => {
  await t.step("loads valid .knox/config.yaml", async () => {
    const dir = await setup(`
output: pr
pr:
  draft: true
  labels:
    - my-label
  reviewers:
    - alice
`);
    try {
      const config = await resolveConfig({ dir, command: "queue" });
      assertEquals(config.output, "pr");
      assertEquals(config.pr.draft, true);
      assertEquals(config.pr.labels, ["my-label"]);
      assertEquals(config.pr.reviewers, ["alice"]);
    } finally {
      await cleanup(dir);
    }
  });

  await t.step("returns defaults when no config file exists", async () => {
    const dir = await Deno.makeTempDir({ prefix: "knox-config-test-" });
    try {
      const config = await resolveConfig({ dir, command: "queue" });
      assertEquals(config.output, "branch");
      assertEquals(config.pr.draft, false);
      assertEquals(config.pr.labels, []);
      assertEquals(config.pr.reviewers, []);
    } finally {
      await cleanup(dir);
    }
  });

  await t.step("CLI --output flag overrides config file value", async () => {
    const dir = await setup(`output: pr`);
    try {
      const config = await resolveConfig({
        dir,
        command: "queue",
        cliOutput: "branch",
      });
      assertEquals(config.output, "branch");
    } finally {
      await cleanup(dir);
    }
  });

  await t.step(
    "resolveConfig with command: run defaults to branch even if config says pr",
    async () => {
      const dir = await setup(`output: pr`);
      try {
        const config = await resolveConfig({ dir, command: "run" });
        assertEquals(config.output, "branch");
      } finally {
        await cleanup(dir);
      }
    },
  );

  await t.step(
    "resolveConfig with command: queue uses config value",
    async () => {
      const dir = await setup(`output: pr`);
      try {
        const config = await resolveConfig({ dir, command: "queue" });
        assertEquals(config.output, "pr");
      } finally {
        await cleanup(dir);
      }
    },
  );

  await t.step(
    "invalid output value in config produces a clear error",
    async () => {
      const dir = await setup(`output: invalid`);
      try {
        await assertRejects(
          () => resolveConfig({ dir, command: "queue" }),
          Error,
          "Invalid output value in .knox/config.yaml",
        );
      } finally {
        await cleanup(dir);
      }
    },
  );

  await t.step("missing pr section uses defaults", async () => {
    const dir = await setup(`output: branch`);
    try {
      const config = await resolveConfig({ dir, command: "queue" });
      assertEquals(config.pr.draft, false);
      assertEquals(config.pr.labels, []);
      assertEquals(config.pr.reviewers, []);
    } finally {
      await cleanup(dir);
    }
  });
});
