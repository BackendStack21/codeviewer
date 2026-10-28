// Signs a release's SHA256SUMS with the Ed25519 key from $CODEVIEWER_UPDATE_KEY (base64 PKCS#8),
// writing SHA256SUMS.sig (raw 64-byte signature, openssl-compatible). Used by the release workflow.
//
//   CODEVIEWER_UPDATE_KEY=… bun scripts/sign.ts dist/release/SHA256SUMS
//
// The signature is then checked against the committed packaging/update-key.pub, so a wrong or
// rotated secret fails the release instead of shipping updates nobody can install.
import path from "node:path";
import { verifySignature } from "../src/server/update.ts";

const file = process.argv[2];
const secret = process.env.CODEVIEWER_UPDATE_KEY;
if (!file) throw new Error("usage: bun scripts/sign.ts <SHA256SUMS>");
if (!secret) throw new Error("CODEVIEWER_UPDATE_KEY is not set: releases must be signed");

const key = await crypto.subtle.importKey("pkcs8", Buffer.from(secret.trim(), "base64"), { name: "Ed25519" }, false, ["sign"]);
const data = new Uint8Array(await Bun.file(file).arrayBuffer());
const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, data));

const pem = await Bun.file(path.resolve(import.meta.dir, "../packaging/update-key.pub")).text();
if (!(await verifySignature(pem, data, sig))) throw new Error("signature doesn't verify with packaging/update-key.pub: wrong signing key");
await Bun.write(`${file}.sig`, sig);
console.log(`signed   ${path.basename(file)}.sig (verified with packaging/update-key.pub)`);
