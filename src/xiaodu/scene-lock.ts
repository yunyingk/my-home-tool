import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XiaoduError } from "./transport.ts";

/** Never auto-remove an existing lock: a crashed process needs an explicit recovery decision. */
export async function withSceneLock<T>(directory: string | undefined, key: string, operation: () => Promise<T>): Promise<T> {
  const folder = directory ?? fileURLToPath(new URL("../../.local/scene-locks", import.meta.url));
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const hash = new Bun.CryptoHasher("sha256").update(key).digest("hex");
  const path = `${folder}/${hash}.lock`;
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) {
    if ((error as { code?: string }).code === "EEXIST") throw new XiaoduError("SCENE_BUSY", "This scene is locked by another operation. Do not blindly remove an existing lock.", { outcome: "not-sent" });
    throw new XiaoduError("INVALID_CONFIGURATION", "Could not create a private scene lock.", { outcome: "not-sent" });
  }
  const owner = crypto.randomUUID();
  try {
    await handle.writeFile(JSON.stringify({ owner, pid: process.pid, startedAt: new Date().toISOString() }));
    return await operation();
  } finally {
    await handle.close();
    // Do not remove a replacement lock if another process or the user changed it.
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.owner === owner) await unlink(path);
  }
}
