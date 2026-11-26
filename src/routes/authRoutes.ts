import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../db";
import { startSession, sessionCookie, requireAuth, hashId, type AuthEnv } from "../auth";
import { createLimiter, clientIp } from "../rateLimit";

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


const UpdateBody = z.object({
    username: z.string().min(3).max(30).optional(),
    email: z.string().email().optional(),
    currentPassword: z.string().max(200).optional(),
});

const PasswordBody = z.object({
    currentPassword: z.string().max(200),
    newPassword: z.string().min(8).max(200),
});

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const FIFTEEN_MIN = 15 * 60 * 1000;
const loginByIp = createLimiter(20, FIFTEEN_MIN);
const loginByEmail = createLimiter(5, FIFTEEN_MIN);

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
        select: { id: true, email: true, username: true, role: true, password: true, googleId: true },
    });
    if (!user) return c.json({ error: "Not logged in" }, 401);

    const { password, googleId, ...rest } = user;
    return c.json({ ...rest, hasPassword: !!password, isGoogle: !!googleId });
});

authRoutes.patch("/profile", requireAuth, zValidator("json", UpdateBody), async (c) => {
    const body = c.req.valid("json");
    const userId = c.get("userId");

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return c.json({ error: "Not logged in" }, 401);

    const data: { username?: string; email?: string; role?: "USER_NOAUTH" } = {};

    if (body.username && body.username !== user.username) {
        const taken = await prisma.user.findFirst({
            where: { username: body.username, NOT: { id: userId } },
        });
        if (taken) return c.json({ error: "Username already taken" }, 409);
        data.username = body.username;
    }

    const newEmail = body.email?.trim().toLowerCase();
    if (newEmail && newEmail !== user.email) {
        if (user.googleId) return c.json({ error: "Google accounts can't change email" }, 400);

        // Changing the email needs the current password
        if (!user.password || !body.currentPassword ||
            !(await argon2.verify(user.password, body.currentPassword))) {
            return c.json({ error: "Current password is wrong" }, 403);
        }
        if (await prisma.user.findUnique({ where: { email: newEmail } })) {
            return c.json({ error: "Email already in use" }, 409);
        }
        data.email = newEmail;
        // An unverified new address shouldn't keep a "verified" role (admins stay)
        if (user.role === "USER_AUTH") data.role = "USER_NOAUTH";
    }

    if (Object.keys(data).length === 0) return c.json({ error: "Nothing to change" }, 400);

    const updated = await prisma.user.update({
        where: { id: userId },
        data,
        select: { id: true, email: true, username: true, role: true },
    });
    return c.json(updated);
});


authRoutes.post("/register", zValidator("json", RegisterBody), async (c) => {
    const { username, password } = c.req.valid("json");
    const email = c.req.valid("json").email.trim().toLowerCase();

    if (await prisma.user.findUnique({ where: { email } })) {
        return c.json({ error: "Email already in use" }, 409);
    }
    if (await prisma.user.findUnique({ where: { username } })) {
        return c.json({ error: "Username already taken" }, 409);
    }

    const user = await prisma.user.create({
        data: { email , username, password: await argon2.hash(password) },
    });
    await startSession(c, user.id);
    return c.json(
        { id: user.id, email: user.email, username: user.username, role: user.role },
        201
    );
});

authRoutes.post("/login", zValidator("json", LoginBody), async (c) => {
    const { password } = c.req.valid("json");
    const email = c.req.valid("json").email.trim().toLowerCase();
    const ip = clientIp(c);

    const wait = Math.max(loginByIp.blocked(ip), loginByEmail.blocked(email));
    if (wait) {
        c.header("Retry-After", String(wait));
        return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.password || !(await argon2.verify(user.password, password))) {
        loginByIp.hit(ip);
        loginByEmail.hit(email);
        return c.json({ error: "Wrong email or password" }, 401);
    }

    loginByEmail.reset(email); // a correct login clears that account's counter
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

authRoutes.post("/password", requireAuth, zValidator("json", PasswordBody), async (c) => {
    const { currentPassword, newPassword } = c.req.valid("json");
    const userId = c.get("userId");

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.password) return c.json({ error: "This account has no password" }, 400);
    if (!(await argon2.verify(user.password, currentPassword))) {
        return c.json({ error: "Current password is wrong" }, 403);
    }

    await prisma.user.update({
        where: { id: userId },
        data: { password: await argon2.hash(newPassword) },
    });

    const raw = getCookie(c, "session");
    await prisma.session.deleteMany({
        where: { userId, ...(raw ? { NOT: { id: hashId(raw) } } : {}) },
    });
    return c.json({ ok: true });
});

authRoutes.post("/logout", async (c) => {
    const raw = getCookie(c, "session");
    if (raw) await prisma.session.deleteMany({ where: { id: hashId(raw) } });

    deleteCookie(c, "session", sessionCookie);
    return c.json({ ok: true });
});