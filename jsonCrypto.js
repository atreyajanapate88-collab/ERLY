import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Recreate __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALGORITHM = 'aes-256-gcm';
const DATA_FILE = path.join(__dirname, 'servers.enc');
const TEMP_FILE = path.join(__dirname, 'servers.enc.tmp');

// Derive a strict 32-byte key from your .env secret
const SECRET_KEY = crypto
  .createHash('sha256')
  .update(String(process.env.ENCRYPTION_SECRET))
  .digest();

// Encrypts any JS object and saves it safely to disk
export function saveEncryptedJson(jsonObject) {
  const jsonString = JSON.stringify(jsonObject);

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, SECRET_KEY, iv);

  let encrypted = cipher.update(jsonString, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  const filePayload = `${iv.toString('hex')}:${authTag}:${encrypted}`;

  // Write atomically to prevent file corruption
  fs.writeFileSync(TEMP_FILE, filePayload, 'utf8');
  fs.renameSync(TEMP_FILE, DATA_FILE);
}

// Reads the encrypted file and returns the parsed JS object
export function loadEncryptedJson() {
  if (!fs.existsSync(DATA_FILE)) {
    return {};
  }

  const filePayload = fs.readFileSync(DATA_FILE, 'utf8');
  if (!filePayload) return {};

  const [ivHex, authTagHex, encryptedHex] = filePayload.split(':');

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, SECRET_KEY, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted);
}
