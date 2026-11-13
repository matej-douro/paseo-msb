import { createServer } from "node:https";
import { readFileSync } from "node:fs";

const [portArg, certPath, keyPath] = process.argv.slice(2);
if (!portArg || !certPath || !keyPath) {
  console.error("usage: node https-echo.mjs <port> <cert.pem> <key.pem>");
  process.exit(2);
}

let requests = 0;

const server = createServer(
  { cert: readFileSync(certPath), key: readFileSync(keyPath) },
  (req, res) => {
    if (req.url === "/__count") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ requests }));
      return;
    }
    requests += 1;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = JSON.stringify(
        {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        },
        null,
        2,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    });
  },
);

server.listen(Number(portArg), "127.0.0.1", () => {
  console.log(`https echo listening on 127.0.0.1:${portArg}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000);
  });
}
