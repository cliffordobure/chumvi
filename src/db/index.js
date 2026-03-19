import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/chama_wallet';
let client = null;
let db = null;

// Options that fix Atlas TLS/SSL errors on cloud runtimes (e.g. Render)
const isAtlas = uri.startsWith('mongodb+srv://');
const clientOptions = isAtlas
  ? { serverSelectionTimeoutMS: 10000, family: 4, autoSelectFamily: false }
  : {};

export async function connect() {
  if (db) return db;
  const c = new MongoClient(uri, clientOptions);
  try {
    await c.connect();
    client = c;
    db = client.db();
    return db;
  } catch (err) {
    await c.close().catch(() => {});
    throw err;
  }
}

export function getDb() {
  if (!db) throw new Error('Database not connected. Call connect() first.');
  return db;
}

export function isConnected() {
  return db != null;
}

export function col(name) {
  return getDb().collection(name);
}

export async function close() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export default { connect, getDb, col, close };
