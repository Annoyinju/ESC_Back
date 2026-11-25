import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../db";
import { startSession, sessionCookie, requireAuth, hashId, type AuthEnv } from "../auth";

const LoginBody = z.object({
    email: z.string().email(),
    password: z.string().min(8).max(200),
});

const RegisterBody = LoginBody.extend({
    username: z.string().min(3).max(30),
});

const GoogleBody = z.object({
    credential: z.string().min(20),
});

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Builds a free username from Google's display name
async function uniqueUsername(base: string): Promise<string> {
    let clean = base.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20);
    if (clean.length < 3) clean = "user" + clean;

    let name = clean;
    while (await prisma.user.findUnique({ where: { username: name } })) {
        name = `${clean}${randomBytes(2).toString("hex")}`;
    }
    return name;
}

export const authRoutes = new Hono<AuthEnv>();

authRoutes.get("/profile", requireAuth, async (c) => {
    const user = await prisma.user.findUnique({
        where: { id: c.get("userId") },
        select: { id: true, email: true, username: true, role: true },
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
    return c.json(
        { id: user.id, email: user.email, username: user.username, role: user.role },
        201
    );
});

authRoutes.post("/login", zValidator("json", LoginBody), async (c) => {
    const { email, password } = c.req.valid("json");

    const user = await prisma.user.findUnique({ where: { email } });
    // Same message for "no such user", "wrong password" and "Google-only account"
    if (!user || !user.password || !(await argon2.verify(user.password, password))) {
        return c.json({ error: "Wrong email or password" }, 401);
    }

    await startSession(c, user.id);
    return c.json({ id: user.id, email: user.email, username: user.username, role: user.role });
});

authRoutes.post("/google", zValidator("json", GoogleBody), async (c) => {
    const { credential } = c.req.valid("json");

    let payload;
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        payload = ticket.getPayload();
    } catch {
        return c.json({ error: "Invalid Google token" }, 401);
    }

    if (!payload?.sub || !payload.email || !payload.email_verified) {
        return c.json({ error: "Google account has no verified email" }, 401);
    }
    const email = payload.email.toLowerCase();

    let user = await prisma.user.findUnique({ where: { googleId: payload.sub } });

    if (!user) {
        // No automatic linking to password accounts (emails aren't verified at registration)
        if (await prisma.user.findUnique({ where: { email } })) {
            return c.json(
                { error: "This email is already registered. Log in with your password." },
                409
            );
        }

        user = await prisma.user.create({
            data: {
                email,
                googleId: payload.sub,
                username: await uniqueUsername(payload.name ?? email.split("@")[0]),
                role: "USER_AUTH", // Google already verified the email
            },
        });
    }

    await startSession(c, user.id);
    return c.json({ id: user.id, email: user.email, username: user.username, role: user.role });
});

authRoutes.post("/logout", async (c) => {
    const raw = getCookie(c, "session");
    if (raw) await prisma.session.deleteMany({ where: { id: hashId(raw) } });

    deleteCookie(c, "session", sessionCookie);
    return c.json({ ok: true });
});