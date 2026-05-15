// Secret readers for ~/.cells/secrets.json.
//
// readSecret and readSecretsKey are near-identical (readSecret rejects
// empty-string values, readSecretsKey doesn't) — kept distinct so existing
// call sites keep their exact behavior. Leaf module: filesystem only.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SECRETS_PATH = join(homedir(), ".cells", "secrets.json");

export async function readSecret(key: string): Promise<string | null> {
  if (!existsSync(SECRETS_PATH)) return null;
  try {
    const s = JSON.parse(await readFile(SECRETS_PATH, "utf-8")) as Record<string, unknown>;
    const v = s[key];
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

export async function readSecretsKey(key: string): Promise<string | null> {
  if (!existsSync(SECRETS_PATH)) return null;
  try {
    const s = JSON.parse(await readFile(SECRETS_PATH, "utf-8"));
    return typeof s[key] === "string" ? s[key] : null;
  } catch {
    return null;
  }
}
