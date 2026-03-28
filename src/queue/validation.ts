import type { QueueItem, QueueManifest, ValidationError } from "./types.ts";

const SETUP_MIGRATION_ERROR =
  "The `setup` field has been renamed to `prepare`. Please update your configuration.";

/** Validate environment fields (features, prepare, image) and reject setup. */
function validateEnvironmentFields(
  // deno-lint-ignore no-explicit-any
  obj: any,
  context: string,
  errors: ValidationError[],
  itemId?: string,
): void {
  // Hard break: reject setup field
  if (obj.setup !== undefined) {
    errors.push({
      ...(itemId && { itemId }),
      field: "setup",
      message: `${context}: ${SETUP_MIGRATION_ERROR}`,
    });
  }

  // Mutual exclusivity: features and image cannot coexist
  if (obj.features !== undefined && obj.image !== undefined) {
    errors.push({
      ...(itemId && { itemId }),
      field: "features",
      message:
        `${context}: 'features' and 'image' cannot be used together. Use 'features' for Knox-managed runtimes, or 'image' for a custom Docker image.`,
    });
  }
}

/** Validate a raw parsed queue manifest and collect all errors. */
export function validateManifest(
  // deno-lint-ignore no-explicit-any
  raw: any,
): { manifest?: QueueManifest; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (raw == null || typeof raw !== "object") {
    errors.push({ message: "Queue file must be a YAML mapping" });
    return { errors };
  }

  // Validate items array exists
  if (!Array.isArray(raw.items)) {
    errors.push({ message: "Queue file must contain an 'items' array" });
    return { errors };
  }

  // Validate concurrency
  if (raw.concurrency !== undefined) {
    if (
      typeof raw.concurrency !== "number" ||
      !Number.isInteger(raw.concurrency) ||
      raw.concurrency < 1
    ) {
      errors.push({
        field: "concurrency",
        message: "concurrency must be a positive integer",
      });
    }
  }

  // Validate defaults environment fields
  if (raw.defaults) {
    validateEnvironmentFields(raw.defaults, "defaults", errors);
  }

  // Validate each item structurally
  const items: QueueItem[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < raw.items.length; i++) {
    const item = raw.items[i];
    const idx = `items[${i}]`;

    if (item == null || typeof item !== "object") {
      errors.push({ message: `${idx}: must be a mapping` });
      continue;
    }

    // Required: id
    if (!item.id || typeof item.id !== "string") {
      errors.push({
        field: "id",
        message: `${idx}: 'id' is required and must be a string`,
      });
      continue;
    }

    // Required: task
    if (!item.task || typeof item.task !== "string") {
      errors.push({
        itemId: item.id,
        field: "task",
        message: `Item '${item.id}': 'task' is required and must be a string`,
      });
    }

    // Duplicate ID check
    if (seenIds.has(item.id)) {
      errors.push({
        itemId: item.id,
        field: "id",
        message: `Duplicate item ID: '${item.id}'`,
      });
    }
    seenIds.add(item.id);

    // Validate dependsOn is an array of strings
    if (item.dependsOn !== undefined) {
      if (!Array.isArray(item.dependsOn)) {
        errors.push({
          itemId: item.id,
          field: "dependsOn",
          message: `Item '${item.id}': 'dependsOn' must be an array`,
        });
      } else {
        for (const dep of item.dependsOn) {
          if (typeof dep !== "string") {
            errors.push({
              itemId: item.id,
              field: "dependsOn",
              message: `Item '${item.id}': 'dependsOn' entries must be strings`,
            });
          }
        }
      }
    }

    // Validate per-item environment fields
    validateEnvironmentFields(
      item,
      `Item '${item.id}'`,
      errors,
      item.id,
    );

    items.push({
      id: item.id,
      task: item.task,
      group: item.group,
      dependsOn: item.dependsOn,
      model: item.model,
      features: item.features,
      prepare: item.prepare,
      image: item.image,
      check: item.check,
      maxLoops: item.maxLoops,
      env: item.env,
      prompt: item.prompt,
      cpu: item.cpu,
      memory: item.memory,
    });
  }

  // Stop here if we have structural errors — referential checks need valid IDs
  if (errors.length > 0) {
    return { errors };
  }

  // Referential: all dependsOn entries reference existing IDs
  for (const item of items) {
    for (const dep of item.dependsOn ?? []) {
      if (!seenIds.has(dep)) {
        errors.push({
          itemId: item.id,
          field: "dependsOn",
          message: `Item '${item.id}': depends on unknown item '${dep}'`,
        });
      }
    }
  }

  // Stop if referential errors — cycle detection assumes valid references
  if (errors.length > 0) {
    return { errors };
  }

  // Cycle detection via topological sort (Kahn's algorithm)
  const cycleErrors = detectCycles(items);
  errors.push(...cycleErrors);

  // Group linearity: within a group, each item has at most one dependent
  const groupErrors = validateGroupLinearity(items);
  errors.push(...groupErrors);

  if (errors.length > 0) {
    return { errors };
  }

  const manifest: QueueManifest = {
    items,
    defaults: raw.defaults,
    concurrency: raw.concurrency,
  };

  return { manifest, errors: [] };
}

/** Detect cycles using Kahn's algorithm. Returns errors with cycle paths. */
function detectCycles(items: QueueItem[]): ValidationError[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const item of items) {
    inDegree.set(item.id, 0);
    adjacency.set(item.id, []);
  }

  for (const item of items) {
    for (const dep of item.dependsOn ?? []) {
      adjacency.get(dep)!.push(item.id);
      inDegree.set(item.id, inDegree.get(item.id)! + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adjacency.get(node)!) {
      const newDegree = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  if (sorted.length === items.length) {
    return [];
  }

  // Find the cycle path for a clear error message
  const remaining = items
    .filter((i) => !sorted.includes(i.id))
    .map((i) => i.id);

  const cyclePath = traceCycle(remaining, items);

  return [{
    message: `Dependency cycle detected: ${cyclePath.join(" → ")}`,
  }];
}

/** Trace a cycle path through remaining nodes for the error message. */
function traceCycle(remaining: string[], items: QueueItem[]): string[] {
  const deps = new Map<string, string[]>();
  const remainSet = new Set(remaining);
  for (const item of items) {
    if (remainSet.has(item.id)) {
      deps.set(
        item.id,
        (item.dependsOn ?? []).filter((d) => remainSet.has(d)),
      );
    }
  }

  // DFS from first remaining node
  const start = remaining[0];
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): string[] | null {
    if (visited.has(node)) {
      const idx = path.indexOf(node);
      return [...path.slice(idx), node];
    }
    visited.add(node);
    path.push(node);
    for (const dep of deps.get(node) ?? []) {
      const result = dfs(dep);
      if (result) return result;
    }
    path.pop();
    return null;
  }

  return dfs(start) ?? remaining;
}

/**
 * Validate group linearity: within a group, the dependency graph forms
 * a linear chain — each item has at most one dependent in the same group.
 */
function validateGroupLinearity(items: QueueItem[]): ValidationError[] {
  const errors: ValidationError[] = [];

  // Group items by group name
  const groups = new Map<string, QueueItem[]>();
  for (const item of items) {
    if (item.group) {
      const group = groups.get(item.group) ?? [];
      group.push(item);
      groups.set(item.group, group);
    }
  }

  for (const [groupName, groupItems] of groups) {
    const groupIds = new Set(groupItems.map((i) => i.id));

    // Count in-group dependents for each item
    const dependentCount = new Map<string, string[]>();
    for (const id of groupIds) {
      dependentCount.set(id, []);
    }

    for (const item of groupItems) {
      for (const dep of item.dependsOn ?? []) {
        if (groupIds.has(dep)) {
          dependentCount.get(dep)!.push(item.id);
        }
      }
    }

    for (const [id, dependents] of dependentCount) {
      if (dependents.length > 1) {
        errors.push({
          itemId: id,
          message:
            `Group '${groupName}' has a diamond: '${id}' is depended on by [${
              dependents.join(", ")
            }] within the group`,
        });
      }
    }
  }

  return errors;
}
