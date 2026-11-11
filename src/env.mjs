import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().positive().default(5000),
    DATABASE_URL: z.string().startsWith("mongodb", "DATABASE_URL must be a MongoDB connection string"),
    AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
    REDIS_URL: z.string().startsWith("redis", "REDIS_URL must be a Redis connection string"),
    // Photo uploads (src/utils/imagekit.mjs). Only the server holds the private key.
    IMAGEKIT_PRIVATE_KEY: z.string().startsWith("private_", "IMAGEKIT_PRIVATE_KEY is the private key from ImageKit, Developer options"),
    IMAGEKIT_URL_ENDPOINT: z.string().url(),
    // Email through Zoho Mail (src/services/emails/zohoMail.js). Leave the user and password out and
    // emails stay in the Outbox unsent. smtp.zoho.com for a personal account, smtppro.zoho.com for a
    // domain (organisation) account; .eu, .in and so on for other data centres.
    ZOHO_SMTP_HOST: z.string().default("smtp.zoho.com"),
    ZOHO_SMTP_PORT: z.coerce.number().int().positive().default(465),
    ZOHO_SMTP_USER: z.string().email().optional(),
    // An app-specific password (Zoho, My Account, Security, App passwords), not the account password.
    ZOHO_SMTP_PASSWORD: z.string().min(1).optional(),
    // Who emails come from. Zoho only sends from the signed-in mailbox or one of its aliases.
    MAIL_FROM: z.string().optional(),
    MAIL_REPLY_TO: z.string().optional(),
    // Where the client runs; invite links point here.
    APP_URL: z.string().url().default("http://localhost:5173"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error("Invalid environment variables:");
    for (const issue of parsed.error.issues) {
        console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
}

export const env = parsed.data;
