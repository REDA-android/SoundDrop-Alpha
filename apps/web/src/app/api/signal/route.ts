import { NextRequest, NextResponse } from "next/server";

interface RoomEntry {
  offer?: string;
  answer?: string;
  updatedAt: number;
}

const rooms = new Map<string, RoomEntry>();
const TTL_MS = 10 * 60 * 1000;

function cleanupExpired() {
  const now = Date.now();
  for (const [key, entry] of Array.from(rooms.entries())) {
    if (now - entry.updatedAt > TTL_MS) {
      rooms.delete(key);
    }
  }
}

export async function GET(req: NextRequest) {
  cleanupExpired();
  const room = req.nextUrl.searchParams.get("room")?.trim().toUpperCase();
  if (!room) {
    return NextResponse.json({ error: "Missing room parameter" }, { status: 400 });
  }
  const entry = rooms.get(room) ?? null;
  return NextResponse.json({ room, entry });
}

export async function POST(req: NextRequest) {
  cleanupExpired();
  const body = (await req.json()) as {
    room?: string;
    role?: "offer" | "answer";
    token?: string;
  };
  const room = body.room?.trim().toUpperCase();
  if (!room || !body.role || !body.token) {
    return NextResponse.json({ error: "room, role, and token are required" }, { status: 400 });
  }
  const existing = rooms.get(room) ?? { updatedAt: Date.now() };
  if (body.role === "offer") {
    existing.offer = body.token;
  } else {
    existing.answer = body.token;
  }
  existing.updatedAt = Date.now();
  rooms.set(room, existing);
  return NextResponse.json({ ok: true, room });
}
