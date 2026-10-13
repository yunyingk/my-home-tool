#!/usr/bin/env bun
import { XiaoduClient, XiaoduError } from "./index.ts";
import { isRecord } from "./xiaodu/transport.ts";
import type { AirConditionerCommand, AirConditionerMode } from "./index.ts";

const HELP = `my-home-tool — Bun + TypeScript 小度工具

用法：bun run cli [--session <file>] <command>

只读：
  snapshot                    完整设备快照（含原始字段）
  devices                     音箱与家电列表
  speakers | appliances       音箱 / 家电
  rooms | houses | scenes      房间 / 家庭 / 场景元数据
  bindings <speaker-id|name>   音箱绑定的红外家电

空调：
  air <device-id|name> on|off
  air <device-id|name> mode COOL|HEAT|AUTO|FAN|DEHUMIDIFICATION
  air <device-id|name> temp-up|temp-down|fan-up|fan-down
  上述 air 命令可加 --dry-run：只读取设备并预览请求，不发送控制。

认证：XIAODU_BDUSS 环境变量，或 .local/session.json 中的 bduss 字段。
成功写 stdout JSON；失败写 stderr JSON 并退出 1。
控制封装通过请求组装测试，尚未完成实机验证；红外记录不保证物理状态。
`;

interface ParsedArguments {
  words: string[];
  sessionFile?: string;
  dryRun: boolean;
  help: boolean;
}

function parseArguments(args: string[]): ParsedArguments {
  const result: ParsedArguments = { words: [], dryRun: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--session") {
      const next = args[++i];
      if (!next || next.startsWith("--") || result.sessionFile) throw new XiaoduError("INVALID_ARGUMENT", "--session requires one file path.");
      result.sessionFile = next;
    } else if (arg.startsWith("--")) throw new XiaoduError("INVALID_ARGUMENT", "Unknown option. Run with --help.");
    else result.words.push(arg);
  }
  return result;
}

function parseAirCommand(words: string[]): AirConditionerCommand {
  if (words.length < 3 || !words[1]?.trim()) throw new XiaoduError("INVALID_ARGUMENT", "air requires a device identifier and an action.");
  const aliases = { on: "turnOn", off: "turnOff", "temp-up": "increaseTemperature", "temp-down": "decreaseTemperature", "fan-up": "increaseFanSpeed", "fan-down": "decreaseFanSpeed" } as const;
  const action = words[2]!;
  if (action === "mode" && words.length === 4) {
    const mode = words[3]!.toUpperCase();
    if (!["COOL", "HEAT", "AUTO", "FAN", "DEHUMIDIFICATION", "SLEEP"].includes(mode)) throw new XiaoduError("INVALID_ARGUMENT", "Unknown air-conditioner mode.");
    return { action: "setMode", mode: mode as AirConditionerMode };
  }
  if (words.length === 3 && Object.hasOwn(aliases, action)) return { action: aliases[action as keyof typeof aliases] };
  throw new XiaoduError("INVALID_ARGUMENT", "Unknown air command or unexpected arguments. Run with --help.");
}

async function loadBduss(sessionFile: string | undefined): Promise<string> {
  if (!sessionFile && process.env.XIAODU_BDUSS) return process.env.XIAODU_BDUSS;
  const file = Bun.file(sessionFile ?? new URL("../.local/session.json", import.meta.url));
  if (!(await file.exists())) throw new XiaoduError("INVALID_CONFIGURATION", "Set XIAODU_BDUSS or provide a local session JSON file containing bduss.");
  let value: unknown;
  try { value = await file.json(); }
  catch { throw new XiaoduError("INVALID_CONFIGURATION", "Could not read the session JSON file."); }
  if (!isRecord(value) || typeof value.bduss !== "string") throw new XiaoduError("INVALID_CONFIGURATION", "Session JSON must contain a bduss string.");
  return value.bduss;
}

export async function runCli(args: string[] = Bun.argv.slice(2)): Promise<void> {
  try {
    const parsed = parseArguments(args);
    if (parsed.help || parsed.words.length === 0) { console.log(HELP); return; }
    const command = parsed.words[0]!;
    let airCommand: AirConditionerCommand | undefined;
    if (command === "air") airCommand = parseAirCommand(parsed.words);
    else {
      const valid = ["snapshot", "devices", "speakers", "appliances", "rooms", "houses", "scenes", "bindings"];
      if (!valid.includes(command) || parsed.words.length !== (command === "bindings" ? 2 : 1) || parsed.dryRun) {
        throw new XiaoduError("INVALID_ARGUMENT", "Unknown command or unexpected arguments. Run with --help.");
      }
    }
    const client = new XiaoduClient({ bduss: await loadBduss(parsed.sessionFile) });
    let data: unknown;
    switch (command) {
      case "snapshot": data = await client.getSnapshot(); break;
      case "devices": { const snapshot = await client.getSnapshot(); data = { speakers: snapshot.speakers, appliances: snapshot.appliances }; break; }
      case "speakers": data = await client.listSpeakers(); break;
      case "appliances": data = await client.listAppliances(); break;
      case "rooms": data = await client.listRooms(); break;
      case "houses": data = await client.listHouses(); break;
      case "scenes": data = await client.listScenes(); break;
      case "bindings": data = await client.getSpeakerBindings(parsed.words[1]!); break;
      case "air": {
        const air = client.airConditioner(parsed.words[1]!);
        data = parsed.dryRun ? await air.preview(airCommand!) : await air.execute(airCommand!);
        break;
      }
    }
    console.log(JSON.stringify({ ok: true, data }));
  } catch (error) {
    const failure = error instanceof XiaoduError ? error.toJSON() : { code: "INTERNAL_ERROR", message: "Unexpected internal failure; credentials are not included in this diagnostic." };
    console.error(JSON.stringify({ ok: false, error: failure }));
    process.exitCode = 1;
  }
}

if (import.meta.main) await runCli();
