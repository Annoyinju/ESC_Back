import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import { randomBytes, createHash } from "node:crypto";
import type { Context } from "hono";
import { prisma } from "./db";
import type { Role } from "./generated/prisma";

const DAY = 60 * 60 * 24;
const isProd = process.env.NODE_ENV === "production";

export type AuthEnv = { Variables: { userId: number; role: Role; } };

export const sessionCookie = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? ("None" as const) : ("Lax" as const),
    partitioned: isProd,
    path: "/",
};


export function hashId(raw: string): string {
    return createHash("sha256").update(raw).digest("hex");
}

export async function startSession(c: Context, userId: number) {
    const raw = randomBytes(32).toString("hex");

    await prisma.session.create({
        data: {
            id: hashId(raw),
            userId,
            expiresAt: new Date(Date.now() + DAY * 1000),
        },
    });

    setCookie(c, "session", raw, { ...sessionCookie, maxAge: DAY }); 
}

export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
    const raw = getCookie(c, "session");
    if (!raw) return c.json({ error: "Not logged in" }, 401);

    const id = hashId(raw);
    const session = await prisma.session.findUnique({
        where: { id },
        include: { user: { select: { role: true } } },
    });
    if (!session) return c.json({ error: "Invalid or expired session" }, 401);

    if (session.expiresAt < new Date()) {
        await prisma.session.deleteMany({ where: { id } });
        return c.json({ error: "Invalid or expired session" }, 401);
    }

    c.set("userId", session.userId);
    c.set("role", session.user.role);
    await next();
});

export const requireRole = (...allowed: Role[]) =>
    createMiddleware<AuthEnv>(async (c, next) => {
        if (!allowed.includes(c.get("role"))) return c.json({ error: "Forbidden" }, 403);
        await next();
    });