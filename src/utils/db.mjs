import { PrismaClient } from '@prisma/client';
import mongoose from 'mongoose';
import { env } from '../env.mjs';

// Create a connection to MongoDB
export const conn = mongoose.createConnection(env.DATABASE_URL);

conn.on('error', (error) => console.error('MongoDB connection error:', error.message));

// Initialize GridFS
let gfs;
conn.once('open', () => {
    gfs = new mongoose.mongo.GridFSBucket(conn.db, {
        bucketName: 'uploads',
    });
});

export { gfs };

/**
 * Prisma client instance
 * @type {PrismaClient}
 */
const prisma = new PrismaClient({
    // Never return secrets unless a query explicitly opts in with omit: { field: false }
    omit: { user: { passwordHash: true } },
});

export default prisma;
