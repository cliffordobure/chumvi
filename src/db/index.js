import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/chama_wallet';
let client = null;
let db = null;

export async function connect() {
  if (db) return db;
  client = new MongoClient(uri);
  await client.connect();
  db = client.db();
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not connected. Call connect() first.');
  return db;
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
