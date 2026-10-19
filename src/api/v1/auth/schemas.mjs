import { z } from 'zod';

const email = z.string({ error: 'Enter your email' }).trim().toLowerCase().email('Enter a valid email');
const name = z.string({ error: 'Enter a name' }).trim().min(1, 'Enter a name').max(80, 'Keep the name under 80 characters');
// bcrypt reads at most 72 bytes, so a longer password would be silently cut.
const newPassword = z.string({ error: 'Choose a password' }).min(8, 'At least 8 characters').max(72, 'At most 72 characters');

export const setupSchema = z.object({ name, email, password: newPassword });

export const loginSchema = z.object({
    email,
    password: z.string({ error: 'Enter your password' }).min(1, 'Enter your password').max(200),
});

export const inviteSchema = z.object({
    name,
    email,
    roleId: z.string({ error: 'Pick a role.' }).trim().min(1, 'Pick a role.'),
});

export const acceptInviteSchema = z.object({
    token: z.string({ error: 'This invite link is not complete.' }).max(200),
    password: newPassword,
});
