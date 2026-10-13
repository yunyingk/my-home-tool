import { records, text } from "./normalize.ts";
import { isRecord, XiaoduError } from "./transport.ts";
import type { Scene } from "./types.ts";

/** Read scene metadata only. Execution and TTS need a separately verified scene. */
export function parseScenes(value: unknown): Scene[] {
  return records(value, "sceneInfos").map(raw => {
    const params = isRecord(raw.sceneParams) && isRecord(raw.sceneParams.params) ? raw.sceneParams.params : {};
    const name = text(raw.name);
    if (!name) throw new XiaoduError("INVALID_RESPONSE", "Missing scene name.");
    return { id: text(raw.sceneId ?? params.sceneId), name, type: text(raw.type), configured: raw.isSet === 1 || raw.isSet === true, raw };
  });
}
