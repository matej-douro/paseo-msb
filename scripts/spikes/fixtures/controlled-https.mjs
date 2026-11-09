import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { BLOCKED_HOST, CONTROLLED_HOST } from "./pins.mjs";

function generateCertificates(directory) {
  const caKey = path.join(directory, "ca.key");
  const caCert = path.join(directory, "ca.crt");
  const serverKey = path.join(directory, "server.key");
  const serverCsr = path.join(directory, "server.csr");
  const serverCert = path.join(directory, "server.crt");
  const extFile = path.join(directory, "server.ext");

  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    caCert,
    "-days",
    "1",
    "-subj",
    "/CN=Paseo MSB Spike Test CA",
  ], { stdio: "ignore" });
  execFileSync("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    serverKey,
    "-out",
    serverCsr,
    "-subj",
    `/CN=${CONTROLLED_HOST}`,
  ], { stdio: "ignore" });
  fs.writeFileSync(extFile, `subjectAltName=DNS:${CONTROLLED_HOST},DNS:${BLOCKED_HOST}\n`);
  execFileSync("openssl", [
    "x509",
    "-req",
    "-in",
    serverCsr,
    "-CA",
    caCert,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    serverCert,
    "-days",
    "1",
    "-extfile",
    extFile,
  ], { stdio: "ignore" });

  return {
    caCert,
    serverCertPath: serverCert,
    key: fs.readFileSync(serverKey),
    cert: fs.readFileSync(serverCert),
  };
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

export async function startControlledHttps() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-msb-spike-tls-"));
  let server = null;
  try {
    const certificates = generateCertificates(directory);
    const requests = [];
    server = https.createServer({ key: certificates.key, cert: certificates.cert }, (request, response) => {
      const chunks = [];
      request.on("data", (chunk) => {
        if (chunks.reduce((total, entry) => total + entry.length, 0) < 8192) chunks.push(chunk);
      });
      request.on("end", () => {
        requests.push({
          method: request.method ?? null,
          url: request.url ?? null,
          headers: { ...request.headers },
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}\n');
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (typeof address !== "object" || !address) {
      throw new Error("controlled HTTPS server did not bind");
    }
    let closed = false;
    return {
      host: CONTROLLED_HOST,
      port: address.port,
      caCertPath: certificates.caCert,
      serverCertPath: certificates.serverCertPath,
      directory,
      requests,
      url: `https://${CONTROLLED_HOST}:${address.port}/collect`,
      blockedUrl: `https://${BLOCKED_HOST}:${address.port}/collect`,
      async close() {
        if (closed) return;
        closed = true;
        await closeServer(server);
        fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await closeServer(server);
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
