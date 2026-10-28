// Creates the Ed25519 release-signing key pair (run once; again only to rotate).
//
//   bun scripts/release-key.ts
//
// The private key goes straight into the repository's Actions secret CODEVIEWER_UPDATE_KEY
// via `gh secret set` (stdin): it is never written to disk or printed. The public key is
// written to packaging/update-key.pub and compiled into every build, so the updater only
// accepts releases signed by the release workflow.
//
// Rotating the key means old versions can no longer verify new releases: users on them
// update manually once. Don't rotate without a reason.
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const repo = "BackendStack21/codeviewer";

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
const spki = Buffer.from(await crypto.subtle.exportKey("spki", kp.publicKey)).toString("base64");

const gh = Bun.spawn(["gh", "secret", "set", "CODEVIEWER_UPDATE_KEY", "--repo", repo], { stdin: "pipe", stdout: "inherit", stderr: "inherit" });
gh.stdin.write(pkcs8);
gh.stdin.end();
if ((await gh.exited) !== 0) throw new Error("gh secret set failed; nothing was written");

const pem = `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----\n`;
await Bun.write(path.join(root, "packaging/update-key.pub"), pem);
console.log("Stored the private key in the CODEVIEWER_UPDATE_KEY secret and wrote packaging/update-key.pub:\n" + pem);
