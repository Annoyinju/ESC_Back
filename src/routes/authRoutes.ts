import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import argon2 from "argon2";
import { prisma } from "../db";
import { startSession, sessionCookie, requireAuth, hashId, type AuthEnv } from "../auth";

const LoginBody = z.object({
    email: z.string().email(),
    password: z.string().min(8).max(200),
});

const RegisterBody = LoginBody.extend({
    username: z.string().min(3).max(30),
});

export const authRoutes = new Hono<AuthEnv>();

authRoutes.get("/profile", requireAuth, async (c) => {
    const user = await prisma.user.findUnique({
        where: { id: c.get("userId") },
        select: { id: true, email: true, username: true },
    });
    if (!user) return c.json({ error: "Not logged in" }, 401);
    return c.json(user);
});

authRoutes.post("/register", zValidator("json", RegisterBody), async (c) => {
    const { email, username, password } = c.req.valid("json");

    if (await prisma.user.findUnique({ where: { email } })) {
        return c.json({ error: "Email already in use" }, 409);
    }
    if (await prisma.user.findUnique({ where: { username } })) {
        return c.json({ error: "Username already taken" }, 409);
    }

    const user = await prisma.user.create({
        data: { email, username, password: await argon2.hash(password) },
    });
    await startSession(c, user.id);
    return c.json({ id: user.id, email: user.email, username: user.username }, 201);
});

authRoutes.post("/login", zValidator("json", LoginBody), async (c) => {
    const { email, password } = c.req.valid("json");

    const user = await prisma.user.findUnique({ where: { email } });
    // Same message for "no such user" and "wrong password"
    if (!user || !(await argon2.verify(user.password, password))) {
        return c.json({ error: "Wrong email or password" }, 401);
    }

    await startSession(c, user.id);
    return c.json({ id: user.id, email: user.email, username: user.username });
});


authRoutes.post("/logout", async (c) => {
    const raw = getCookie(c, "session");
    if (raw) await prisma.session.deleteMany({ where: { id: hashId(raw) } });

    deleteCookie(c, "session", sessionCookie);
    return c.json({ ok: true });
});