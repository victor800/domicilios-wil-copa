// lib/db.js
import mongoose from 'mongoose'

const URI = process.env.MONGODB_URI
if (!URI) throw new Error('MONGODB_URI no definida en .env')

let cached = global._mongoose || (global._mongoose = { conn: null, promise: null })

export async function dbConnect() {
  if (cached.conn) return cached.conn

  if (!cached.promise) {
    cached.promise = mongoose.connect(URI, {
      bufferCommands:           false,
      serverSelectionTimeoutMS: 8000,
    })
  }

  cached.conn = await cached.promise
  return cached.conn
}