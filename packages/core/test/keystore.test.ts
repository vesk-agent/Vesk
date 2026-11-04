import { test } from "node:test";
import assert from "node:assert/strict";
import { decryptKeystore, encryptKeystore } from "../src/wallet/keystore.js";

test("keystore round-trips and rejects a wrong passphrase or tampering", async () => {
  const plain = { secretKey: "5".repeat(88), secrets: { ANTHROPIC_API_KEY: "sk-test" } };
  const f = await encryptKeystore(plain, "PUBKEY", "correct horse battery");
  assert.ok(!JSON.stringify(f).includes("sk-test"));
  assert.deepEqual(await decryptKeystore(f, "correct horse battery"), plain);
  await assert.rejects(decryptKeystore(f, "wrong passphrase!!"), /Wrong passphrase/);
  await assert.rejects(decryptKeystore({ ...f, publicKey: "OTHER" }, "correct horse battery"), /Wrong passphrase/);
  await assert.rejects(encryptKeystore(plain, "PUBKEY", "short"), /at least 10/);
});
