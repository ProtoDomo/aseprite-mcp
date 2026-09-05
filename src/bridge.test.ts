import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsepriteMcpServer } from "./index.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture(state: Record<string, unknown>, heartbeat?: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "aseprite-bridge-test-"));
  dirs.push(dir);
  await writeFile(join(dir, "state.json"), JSON.stringify(state));
  if (heartbeat) await writeFile(join(dir, "heartbeat.json"), JSON.stringify(heartbeat));
  const server = new AsepriteMcpServer();
  server.bridgeDir = () => dir;
  return { server, dir };
}
const live = () => ({ sessionId: "test-session", generatedAt: new Date().toISOString() });
const state = { sessionId: "test-session", reason: "sitechange", sprite: { exists: false } };
const data = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe("bridge editor identity and liveness", () => {
  it("does not report an exited editor connected even with a fresh heartbeat", async () => {
    const { server } = await fixture({ ...state, reason: "extension-exit" }, live());
    const status = data(await server["handleGetBridgeStatus"]({}));
    expect(status.connected).toBe(false);
    expect(status.stateAvailable).toBe(true);
    expect(status.connectionReason).toBe("extension-exited");
    expect((await server["handleGetActiveSpriteContext"]({})).isError).toBe(true);
  });
  it.each([
    undefined,
    { ...live(), generatedAt: "2000-01-01T00:00:00Z" },
    { ...live(), sessionId: "another-editor" },
    { ...live(), generatedAt: "invalid" },
  ])("rejects a missing, expired, mismatched or invalid heartbeat", async heartbeat => {
    const { server } = await fixture(state, heartbeat);
    expect(data(await server["handleGetBridgeStatus"]({})).connected).toBe(false);
  });
  it("accepts a fresh heartbeat even when the last canvas event is old", async () => {
    const { server } = await fixture({ ...state, generatedAt: "2000-01-01T00:00:00Z" }, live());
    expect(data(await server["handleGetBridgeStatus"]({})).connected).toBe(true);
  });
  it("never resolves a leftover shared snapshot after the active document closes", async () => {
    const { server, dir } = await fixture(state, live());
    await writeFile(join(dir, "active-sprite.aseprite"), "leftover");
    expect(data(await server["handleGetBridgeStatus"]({})).activeSpriteFile).toBeNull();
  });
  it("requires an explicit current snapshot for a modified saved document", async () => {
    const { server, dir } = await fixture(state, live());
    const saved = join(dir, "saved.aseprite");
    const snapshot = join(dir, "active-sprite.aseprite");
    await writeFile(saved, "saved pixels");
    await writeFile(snapshot, "unsaved pixels");
    const sprite = { exists: true, isModified: true, filePath: saved };
    await writeFile(join(dir, "state.json"), JSON.stringify({ ...state, sprite }));
    expect(data(await server["handleGetBridgeStatus"]({})).activeSpriteFile).toBeNull();
    await writeFile(join(dir, "state.json"), JSON.stringify({ ...state, sprite: { ...sprite, snapshotPath: snapshot, snapshotSavedAt: new Date().toISOString() } }));
    const status = data(await server["handleGetBridgeStatus"]({}));
    expect(status.activeSpriteSource).toBe("snapshot");
    expect(status.activeSpriteFile).toBe(snapshot);
  });
  it("rejects saved and snapshot sources after heartbeat expiry", async () => {
    const { server, dir } = await fixture(state, { ...live(), generatedAt: "2000-01-01T00:00:00Z" });
    const saved = join(dir, "saved.aseprite");
    await writeFile(saved, "pixels");
    await writeFile(join(dir, "state.json"), JSON.stringify({ ...state, sprite: { exists: true, filePath: saved } }));
    expect(data(await server["handleGetBridgeStatus"]({})).activeSpriteFile).toBeNull();
    expect((await server["handleGetActiveSpriteInfo"]({})).isError).toBe(true);
  });
});
