import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

interface RoomEntry {
  offer?: string;
  answer?: string;
  updatedAt: number;
}

const TTL_SECONDS = 600;
const TTL_MS = TTL_SECONDS * 1000;
const LOCAL_STORE_PATH = path.join(os.tmpdir(), "sounddrop-alpha-signal-rooms.json");

function getRedisConfig(): { url: string; token: string } | null {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? "";
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? "";
  if (url && token) {
    return { url: url.replace(/\/$/, ""), token };
  }
  return null;
}

async function redisGetRoom(
  cfg: { url: string; token: string },
  room: string,
): Promise<RoomEntry | null> {
  const res = await fetch(`${cfg.url}/get/${encodeURIComponent(`sd1:room:${room}`)}`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Redis GET failed with status ${res.status}`);
  }
  const data = (await res.json()) as { result: string | null };
  if (!data.result) return null;
  return JSON.parse(data.result) as RoomEntry;
}

async function redisSetRoom(
  cfg: { url: string; token: string },
  room: string,
  entry: RoomEntry,
): Promise<void> {
  const key = encodeURIComponent(`sd1:room:${room}`);
  const value = encodeURIComponent(JSON.stringify(entry));
  const res = await fetch(`${cfg.url}/setex/${key}/${TTL_SECONDS}/${value}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Redis SETEX failed with status ${res.status}`);
  }
}

async function readLocalStore(): Promise<Record<string, RoomEntry>> {
  try {
    const raw = await fs.readFile(LOCAL_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, RoomEntry>;
    const now = Date.now();
    const cleaned: Record<string, RoomEntry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (now - v.updatedAt <= TTL_MS) {
        cleaned[k] = v;
      }
    }
    return cleaned;
  } catch {
    return {};
  }
}

async function writeLocalStore(store: Record<string, RoomEntry>): Promise<void> {
  await fs.writeFile(LOCAL_STORE_PATH, JSON.stringify(store), "utf8");
}

export async function GET(req: NextRequest) {
  const room = req.nextUrl.searchParams.get("room")?.trim().toUpperCase();
  if (!room) {
    return NextResponse.json({ error: "Missing room parameter" }, { status: 400 });
  }

  try {
    const redis = getRedisConfig();
    if (redis) {
      const entry = await redisGetRoom(redis, room);
      return NextResponse.json({ room, entry, storage: "redis" });
    }

    const store = await readLocalStore();
    return NextResponse.json({
      room,
      entry: store[room] ?? null,
      storage: "local-file",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Signal store error" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    room?: string;
    role?: "offer" | "answer";
    token?: string;
  };
  const room = body.room?.trim().toUpperCase();
  if (!room || !body.role || !body.token) {
    return NextResponse.json(
      { error: "room, role, and token are required" },
      { status: 400 },
    );
  }

  try {
    const redis = getRedisConfig();
    if (redis) {
      const existing = (await redisGetRoom(redis, room)) ?? {
        updatedAt: Date.now(),
      };
      if (body.role === "offer") {
        existing.offer = body.token;
      } else {
        existing.answer = body.token;
      }
      existing.updatedAt = Date.now();
      await redisSetRoom(redis, room, existing);
      return NextResponse.json({ ok: true, room, storage: "redis" });
    }

    const store = await readLocalStore();
    const existing = store[room] ?? { updatedAt: Date.now() };
    if (body.role === "offer") {
      existing.offer = body.token;
    } else {
      existing.answer = body.token;
    }
    existing.updatedAt = Date.now();
    store[room] = existing;
    await writeLocalStore(store);
    return NextResponse.json({ ok: true, room, storage: "local-file" });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Signal store error" },
      { status: 500 },
    );
  }
}
