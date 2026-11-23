import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { deleteCookie } from "hono/cookie";
import { z } from "zod";
import argon2 from "argon2";
import { prisma } from "../db";
import { startSession } from "../auth";

const Credentials = z.object({
    email: z.string().email(),
    password: z.string().min(8).max(200),
    username: z.string().min(3).max(20)
});

export const authRoutes = new Hono();

authRoutes.post("/register", zValidator("json", Credentials), async (c) => {
    const { email, username, password } = c.req.valid("json");

    if (await prisma.user.findUnique({ where: { email } })) {
        return c.json({ error: "Email already in use" }, 409);
    }

    const user = await prisma.user.create({
        data: { email, username, password: await argon2.hash(password) },
    });
    await startSession(c, user.id);
    return c.json({ id: user.id, email: user.email }, 201);
});

authRoutes.post("/login", zValidator("json", Credentials), async (c) => {
    const { email, password } = c.req.valid("json");

    const user = await prisma.user.findUnique({ where: { email } });
    // Same message for "no such user" and "wrong password"
    if (!user || !(await argon2.verify(user.password, password))) {
        return c.json({ error: "Wrong email or password" }, 401);
    }

    await startSession(c, user.id);
    return c.json({ id: user.id, email: user.email });
});

authRoutes.post("/logout", (c) => {
    deleteCookie(c, "token", { path: "/" });
    return c.json({ ok: true });
});