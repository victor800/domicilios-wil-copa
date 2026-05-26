// lib/db.js
import mongoose from 'mongoose'

const URI = process.env.MONGODB_URI
if (!URI) throw new Error('MONGODB_URI no definida en .env')

let conn    = null
let promise = null

export async function dbConnect() {
  if (conn && mongoose.connection.readyState === 1) return conn

  if (!promise) {
    promise = mongoose.connect(URI, {
      bufferCommands:           false,
      serverSelectionTimeoutMS: 8000,
    })
  }

  conn = await promise
  return conn
}