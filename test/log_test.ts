import { assertEquals, assertMatch, assertNotMatch } from "@std/assert";
import { log } from "../src/log.ts";
import type { LogLevel } from "../src/log.ts";

// Capture console.error output for assertions
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

// Reset log level to "info" after each test by resetting to default
function withLevel(level: LogLevel, fn: () => void): void {
  log.setLevel(level);
  try {
    fn();
  } finally {
    log.setLevel("info");
  }
}

Deno.test("log level filtering", async (t) => {
  await t.step("debug suppressed at info level (default)", () => {
    log.setLevel("info");
    const lines = captureStderr(() => log.debug("should not appear"));
    assertEquals(lines.length, 0);
  });

  await t.step("info emitted at info level", () => {
    log.setLevel("info");
    const lines = captureStderr(() => log.info("hello"));
    assertEquals(lines.length, 1);
  });

  await t.step("debug emitted at debug level", () => {
    withLevel("debug", () => {
      const lines = captureStderr(() => log.debug("debug msg"));
      assertEquals(lines.length, 1);
    });
  });

  await t.step("info suppressed at warn level", () => {
    withLevel("warn", () => {
      const lines = captureStderr(() => log.info("should not appear"));
      assertEquals(lines.length, 0);
    });
  });

  await t.step("warn suppressed at error level", () => {
    withLevel("error", () => {
      const lines = captureStderr(() => log.warn("should not appear"));
      assertEquals(lines.length, 0);
    });
  });

  await t.step("error always emitted at error level", () => {
    withLevel("error", () => {
      const lines = captureStderr(() => log.error("error msg"));
      assertEquals(lines.length, 1);
    });
  });

  await t.step("warn emitted at warn level", () => {
    withLevel("warn", () => {
      const lines = captureStderr(() => log.warn("warn msg"));
      assertEquals(lines.length, 1);
    });
  });

  // Reset to info for subsequent tests
  log.setLevel("info");
});

Deno.test("log always is never suppressed", async (t) => {
  await t.step("always emits at error level (most restrictive)", () => {
    withLevel("error", () => {
      const lines = captureStderr(() => log.always("important"));
      assertEquals(lines.length, 1);
    });
  });

  await t.step("always emits at warn level", () => {
    withLevel("warn", () => {
      const lines = captureStderr(() => log.always("important"));
      assertEquals(lines.length, 1);
    });
  });

  await t.step("always emits at debug level", () => {
    withLevel("debug", () => {
      const lines = captureStderr(() => log.always("important"));
      assertEquals(lines.length, 1);
    });
  });
});

Deno.test("log prefix formatting (no color)", async (t) => {
  // Set NO_COLOR to avoid color codes in prefix assertions
  const prevNoColor = Deno.env.get("NO_COLOR");
  Deno.env.set("NO_COLOR", "1");

  try {
    await t.step("debug uses [knox:DEBUG] prefix", () => {
      withLevel("debug", () => {
        const lines = captureStderr(() => log.debug("msg"));
        assertEquals(lines[0], "[knox:DEBUG] msg");
      });
    });

    await t.step("info uses [knox:INFO] prefix", () => {
      const lines = captureStderr(() => log.info("msg"));
      assertEquals(lines[0], "[knox:INFO] msg");
    });

    await t.step("warn uses [knox:WARN] prefix", () => {
      const lines = captureStderr(() => log.warn("msg"));
      assertEquals(lines[0], "[knox:WARN] msg");
    });

    await t.step("error uses [knox:ERROR] prefix", () => {
      const lines = captureStderr(() => log.error("msg"));
      assertEquals(lines[0], "[knox:ERROR] msg");
    });

    await t.step("always uses [knox] prefix (no level tag)", () => {
      const lines = captureStderr(() => log.always("msg"));
      assertEquals(lines[0], "[knox] msg");
    });
  } finally {
    if (prevNoColor === undefined) {
      Deno.env.delete("NO_COLOR");
    } else {
      Deno.env.set("NO_COLOR", prevNoColor);
    }
  }
});

Deno.test("log color suppression with NO_COLOR", async (t) => {
  const prevNoColor = Deno.env.get("NO_COLOR");
  Deno.env.set("NO_COLOR", "1");

  try {
    await t.step("no ANSI codes in warn output when NO_COLOR set", () => {
      const lines = captureStderr(() => log.warn("msg"));
      assertNotMatch(lines[0], /\x1b\[/);
    });

    await t.step("no ANSI codes in error output when NO_COLOR set", () => {
      const lines = captureStderr(() => log.error("msg"));
      assertNotMatch(lines[0], /\x1b\[/);
    });

    await t.step("no ANSI codes in debug output when NO_COLOR set", () => {
      withLevel("debug", () => {
        const lines = captureStderr(() => log.debug("msg"));
        assertNotMatch(lines[0], /\x1b\[/);
      });
    });
  } finally {
    if (prevNoColor === undefined) {
      Deno.env.delete("NO_COLOR");
    } else {
      Deno.env.set("NO_COLOR", prevNoColor);
    }
  }
});

Deno.test("setLevel changes threshold at runtime", () => {
  log.setLevel("warn");
  const suppressed = captureStderr(() => log.info("should be suppressed"));
  assertEquals(suppressed.length, 0);

  log.setLevel("debug");
  const emitted = captureStderr(() => log.info("should appear"));
  assertEquals(emitted.length, 1);

  // Reset
  log.setLevel("info");
});

Deno.test("log message content is preserved", () => {
  Deno.env.set("NO_COLOR", "1");
  try {
    const lines = captureStderr(() => log.info("hello world 123"));
    assertMatch(lines[0], /hello world 123/);
  } finally {
    Deno.env.delete("NO_COLOR");
  }
});
