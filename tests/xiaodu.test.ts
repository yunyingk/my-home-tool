import { describe, expect, test } from "bun:test";
import snapshotFixture from "./fixtures/snapshot.json";
import bindingsFixture from "./fixtures/bindings.json";
import { XiaoduClient, XiaoduError } from "../src/index.ts";
import type { AirConditionerCommand, FetchFunction, RawObject } from "../src/index.ts";

interface CapturedRequest { url: string; init: RequestInit; body: RawObject | null }
function harness(snapshot: unknown = snapshotFixture, reply: unknown = { status: 0, msg: "", data: { status: "succeed" } }) {
  const requests: CapturedRequest[] = [];
  const fetch: FetchFunction = async (url, init) => {
    requests.push({ url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
    const value = new URL(url).pathname.endsWith("/appliance") ? snapshot : reply;
    return Response.json(value);
  };
  return { client: new XiaoduClient({ bduss: "test-session-value", fetch }), requests };
}

describe("device parsing and read protocols", () => {
  test("normalizes the captured snapshot while preserving unknown fields and state provenance", async () => {
    const { client, requests } = harness();
    const snapshot = await client.getSnapshot();
    expect(snapshot.speakers[0]).toMatchObject({ clientId: "speaker-client-1", cuid: "speaker-cuid-1", online: true });
    expect(snapshot.appliances[0]).toMatchObject({ id: "ac-1", controlType: "__speaker_ir__", state: { source: "platform-record", physicalStateVerified: false } });
    expect(snapshot.appliances[0]!.state.attributes.temperature).toEqual({ value: 24, sampledAt: 1791131701 });
    expect(snapshot.rooms[0]).toMatchObject({ id: "room-bedroom", name: "大卧室" });
    expect(snapshot.scenes[0]).toMatchObject({ configured: false, id: null });
    expect(snapshot.raw.unmappedServerField).toEqual({ retained: true });
    expect(requests[0]!.body).toEqual({ method: "GET_USER_ALL_APPLIANCES", params: { from: "h5_control", withscene: 1, generalscene: 3, version: "2.0" } });
    expect(requests[0]!.init.redirect).toBe("manual");
    expect(new Headers(requests[0]!.init.headers).get("Cookie")).toBe("BDUSS=test-session-value");
  });

  test("reads floorList room data using the observed GET protocol", async () => {
    const { client, requests } = harness(undefined, { status: 0, data: { floorList: [{ floorId: -1, floorName: "默认楼层", roomList: [{ roomId: "r1", roomName: "客厅" }] }] } });
    expect(await client.listRooms()).toMatchObject([{ id: "r1", floorId: "-1" }]);
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe("/saiya/smarthome/groupsystem");
    expect(url.searchParams.get("method")).toBe("GROUP_INFO");
    expect(requests[0]!.init.method).toBe("GET");
    expect(requests[0]!.body).toBeNull();
  });

  test("reads houses without switching the active house", async () => {
    const { client, requests } = harness(undefined, { status: 0, data: { houseList: [{ houseId: "house-1", houseName: "测试家庭", isDefault: true, isOwner: true }] } });
    expect(await client.listHouses()).toMatchObject([{ id: "house-1", isDefault: true }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toEqual({ method: "HOUSE_LIST", params: { entityId: "", entityType: "" } });
  });

  test("resolves a unique speaker name and normalizes snake_case bindings", async () => {
    const { client, requests } = harness(undefined, bindingsFixture);
    const bindings = await client.getSpeakerBindings("小度1s");
    expect(bindings[0]).toMatchObject({ id: "ac-1", online: true, speakerClientId: "speaker-client-1", airConditionerCapabilities: [{ mode: "COOL", minTemperature: 16, maxTemperature: 30 }] });
    expect(requests[1]!.body).toEqual({ method: "GET_CLIENT_DETAILS", params: { clientId: "speaker-client-1", version: 1, from: "h5" } });
  });

  test("fails on missing lists instead of silently returning an empty inventory", async () => {
    const { client } = harness({ status: 0, data: { client: [], appliances: {} } });
    await expect(client.getSnapshot()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("transport errors", () => {
  test("HTTP 200 with business status 2 is an authentication error", async () => {
    await expect(harness({ status: 2, msg: "not login" }).client.getSnapshot()).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED", details: { httpStatus: 200, apiStatus: 2 } });
  });

  test("redacts credentials even when an API error echoes the value", async () => {
    const { client } = harness({ status: 7, msg: "invalid test-session-value" });
    try { await client.getSnapshot(); throw new Error("Expected rejection"); }
    catch (error) { expect(error).toBeInstanceOf(XiaoduError); expect(JSON.stringify((error as XiaoduError).toJSON())).not.toContain("test-session-value"); }
  });

  test("rejects absent business status and non-JSON responses", async () => {
    await expect(harness({ data: {} }).client.getSnapshot()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const client = new XiaoduClient({ bduss: "test", fetch: async () => new Response("<html>login</html>") });
    await expect(client.getSnapshot()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test("never follows a redirect carrying account credentials", async () => {
    let calls = 0;
    const client = new XiaoduClient({ bduss: "test", fetch: async (_url, init) => { calls++; expect(init.redirect).toBe("manual"); return new Response(null, { status: 302, headers: { Location: "https://example.org" } }); } });
    await expect(client.getSnapshot()).rejects.toMatchObject({ code: "HTTP_ERROR", details: { httpStatus: 302 } });
    expect(calls).toBe(1);
  });

  test("maps HTTP authentication rejection and server failure", async () => {
    for (const [status, code] of [[401, "AUTHENTICATION_REQUIRED"], [503, "HTTP_ERROR"]] as const) {
      const client = new XiaoduClient({ bduss: "test", fetch: async () => new Response(null, { status }) });
      await expect(client.getSnapshot()).rejects.toMatchObject({ code });
    }
  });

  test("validates session headers and timeouts before sending a request", () => {
    for (const bduss of ["", "BDUSS=value", "value; other=cookie", "value\r\nheader"]) expect(() => new XiaoduClient({ bduss })).toThrow(XiaoduError);
    for (const timeoutMs of [0, -1, Infinity, 0.5]) expect(() => new XiaoduClient({ bduss: "test", timeoutMs })).toThrow(XiaoduError);
  });

  test("aborts timed-out requests with a bounded wait", async () => {
    const client = new XiaoduClient({ bduss: "test", timeoutMs: 5, fetch: async (_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
    await expect(client.getSnapshot()).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  test("the deadline still applies to a transport that ignores abort signals", async () => {
    const client = new XiaoduClient({ bduss: "test", timeoutMs: 5, fetch: async () => new Promise(() => {}) });
    await expect(client.getSnapshot()).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("infrared control request construction", () => {
  const commands: [AirConditionerCommand, string][] = [
    [{ action: "turnOn" }, "TurnOnRequest"], [{ action: "turnOff" }, "TurnOffRequest"],
    [{ action: "setMode", mode: "HEAT" }, "SetModeRequest"],
    [{ action: "increaseTemperature" }, "IncrementTemperatureRequest"], [{ action: "decreaseTemperature" }, "DecrementTemperatureRequest"],
    [{ action: "increaseFanSpeed" }, "IncrementFanSpeedRequest"], [{ action: "decreaseFanSpeed" }, "DecrementFanSpeedRequest"],
  ];
  for (const [command, directive] of commands) test(`${directive} matches the current frontend protocol`, async () => {
    const { client, requests } = harness();
    const result = await client.airConditioner("格力空调").execute(command);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toBe("https://xiaodu.baidu.com/saiya/smarthome/directivesend?from=h5_control");
    expect(requests[1]!.body).toEqual({ header: { namespace: "DuerOS.ConnectedHome.Control", name: directive, payloadVersion: 1 }, payload: { ...(command.action === "setMode" ? { mode: { value: "HEAT" } } : {}), applianceId: "ac-1", appliance: { applianceId: ["ac-1"] }, parameters: { proxyConnectStatus: false } } });
    expect(result).toMatchObject({ outcome: "accepted", physicalStateVerified: false });
  });

  test("dry-run reads fresh metadata but never sends a control request", async () => {
    const { client, requests } = harness();
    const prepared = await client.airConditioner("ac-1").preview({ action: "turnOn" });
    expect(prepared.verification).toBe("request-construction-only");
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(prepared)).not.toContain("test-session-value");
  });

  test("rejects ambiguous names, missing devices, offline speakers and unsupported cloud transports", async () => {
    const duplicate = structuredClone(snapshotFixture);
    duplicate.data.appliances.push({ ...duplicate.data.appliances[0]!, applianceId: "ac-2" });
    const { client, requests } = harness(duplicate);
    await expect(client.airConditioner("格力空调").turnOn()).rejects.toMatchObject({ code: "AMBIGUOUS_DEVICE" });
    expect(requests).toHaveLength(1);
    await expect(harness().client.airConditioner("missing").turnOn()).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
    const offline = structuredClone(snapshotFixture); offline.data.appliances[0]!.isClientOnline = false;
    await expect(harness(offline).client.airConditioner("ac-1").turnOn()).rejects.toMatchObject({ code: "DEVICE_OFFLINE" });
    const cloud = structuredClone(snapshotFixture); cloud.data.appliances[0]!.botId = "cloud";
    await expect(harness(cloud).client.airConditioner("ac-1").turnOn()).rejects.toMatchObject({ code: "UNSUPPORTED_ACTION" });
  });

  test("ignores broad generic temperature ranges and enforces real mode limits", async () => {
    const data = structuredClone(snapshotFixture); data.data.appliances[0]!.stateSetting.temperature.value = 30;
    const { client, requests } = harness(data);
    await expect(client.airConditioner("ac-1").increaseTemperature()).rejects.toMatchObject({ code: "OUT_OF_RANGE" });
    expect(requests).toHaveLength(1);
    data.data.appliances[0]!.stateSetting.temperature.value = 16;
    await expect(harness(data).client.airConditioner("ac-1").decreaseTemperature()).rejects.toMatchObject({ code: "OUT_OF_RANGE" });
  });

  test("rejects temperature control without a mode range and fixed dry-mode fan changes", async () => {
    const data = structuredClone(snapshotFixture); data.data.appliances[0]!.stateSetting.mode.value = "AUTO";
    await expect(harness(data).client.airConditioner("ac-1").increaseTemperature()).rejects.toMatchObject({ code: "UNAVAILABLE_STATE" });
    data.data.appliances[0]!.stateSetting.mode.value = "DEHUMIDIFICATION";
    data.data.appliances[0]!.stateSetting.fanSpeed.value = 1;
    await expect(harness(data).client.airConditioner("ac-1").increaseFanSpeed()).rejects.toMatchObject({ code: "OUT_OF_RANGE" });
    await expect(harness(data).client.airConditioner("ac-1").decreaseFanSpeed()).rejects.toMatchObject({ code: "OUT_OF_RANGE" });
  });

  test("checks advertised actions and modes rather than generic panel options", async () => {
    const data = structuredClone(snapshotFixture); data.data.appliances[0]!.supportActions = ["turnOff"];
    await expect(harness(data).client.airConditioner("ac-1").turnOn()).rejects.toMatchObject({ code: "UNSUPPORTED_ACTION" });
    await expect(harness().client.airConditioner("ac-1").setMode("SLEEP")).rejects.toMatchObject({ code: "UNSUPPORTED_ACTION" });
  });

  test("reports nested command rejection even when top-level status is successful", async () => {
    const { client } = harness(undefined, { status: 0, data: { status: "FAILED" } });
    await expect(client.airConditioner("ac-1").turnOff()).rejects.toMatchObject({ code: "COMMAND_REJECTED", details: { outcome: "rejected" } });
  });

  test("retains pending task information without claiming physical completion", async () => {
    const { client } = harness(undefined, { status: 0, data: { status: "UNKNOWN", task_id: "task-1" } });
    expect(await client.airConditioner("ac-1").turnOn()).toMatchObject({ outcome: "accepted", serverStatus: "UNKNOWN", taskId: "task-1", physicalStateVerified: false });
  });

  test("a failed write is never retried and its outcome is unknown", async () => {
    let writeCalls = 0;
    const client = new XiaoduClient({ bduss: "test", fetch: async url => {
      if (new URL(url).pathname.endsWith("/appliance")) return Response.json(snapshotFixture);
      writeCalls++; throw new Error("network disconnected");
    } });
    await expect(client.airConditioner("ac-1").increaseTemperature()).rejects.toMatchObject({ code: "REQUEST_FAILED", details: { outcome: "unknown" } });
    expect(writeCalls).toBe(1);
  });

  test("missing control data leaves the write outcome unknown", async () => {
    await expect(harness(undefined, { status: 0 }).client.airConditioner("ac-1").turnOn()).rejects.toMatchObject({ code: "INVALID_RESPONSE", details: { outcome: "unknown" } });
  });

  test("a write timeout reports an unknown outcome without resending", async () => {
    let writeCalls = 0;
    const client = new XiaoduClient({ bduss: "test", timeoutMs: 5, fetch: async url => {
      if (new URL(url).pathname.endsWith("/appliance")) return Response.json(snapshotFixture);
      writeCalls++; return new Promise(() => {});
    } });
    await expect(client.airConditioner("ac-1").turnOff()).rejects.toMatchObject({ code: "TIMEOUT", details: { outcome: "unknown" } });
    expect(writeCalls).toBe(1);
  });
});

describe("CLI process contract", () => {
  async function cli(args: string[]) {
    const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], { cwd: new URL("../", import.meta.url).pathname, env: { ...process.env, XIAODU_BDUSS: "" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  }

  test("help needs no authentication and does not perform a request", async () => {
    const result = await cli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--dry-run");
    expect(result.stderr).toBe("");
  });

  test("rejects invalid control arguments before loading a session", async () => {
    const result = await cli(["--session", "/nonexistent-session.json", "air", "ac-1", "on", "unexpected"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  });

  test("session configuration errors are structured stderr with nonzero exit", async () => {
    const result = await cli(["--session", "tests/fixtures/invalid-session.json", "devices"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: "INVALID_CONFIGURATION" } });
    expect(result.stdout).toBe("");
  });
});
