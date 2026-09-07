import { resolve } from "node:path";

import { buildServer } from "./server.js";

const host = process.env.AFR_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.AFR_PORT ?? "4317", 10);
const launchDirectory = process.env.INIT_CWD ?? process.cwd();
const dataDir = resolve(launchDirectory, process.env.AFR_DATA_DIR ?? ".afr");
const networkReadAllowlist = (process.env.AFR_NETWORK_READ_ALLOWLIST ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const hostedProjectRoots = (process.env.AFR_HOSTED_PROJECT_ROOTS ?? launchDirectory)
  .split(",")
  .map((entry) => resolve(launchDirectory, entry.trim()))
  .filter((entry) => entry.length > 0);
const providerEgressAllowlist = (process.env.AFR_PROVIDER_EGRESS_ALLOWLIST ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const providerEgressTrustedPrivateAddresses = (
  process.env.AFR_PROVIDER_EGRESS_TRUSTED_PRIVATE_ADDRESSES ?? ""
)
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

let server: Awaited<ReturnType<typeof buildServer>> | undefined;
try {
  server = await buildServer({
    dataDir,
    logger: true,
    networkRead: { allowlist: networkReadAllowlist },
    hosted: {
      allowedProjectRoots: hostedProjectRoots,
      binary: process.env.AFR_CODEX_BIN ?? "codex",
      providerEgressAllowlist,
      providerEgressTrustedPrivateAddresses,
      allowSyntheticProviderDns: process.env.AFR_PROVIDER_EGRESS_ALLOW_SYNTHETIC_DNS === "true"
    }
  });
  await server.app.listen({ host, port });
  server.app.log.info(
    { dataDir, tokenPath: server.tokenPath, startup: server.startupReport },
    "AFR started; the session token value is never logged"
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  if ((error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE") {
    reportError(`AFR 无法启动：${host}:${port} 已被占用。请停止已有服务或设置其他 AFR_PORT。`);
  } else if ((error as NodeJS.ErrnoException | undefined)?.code === "EACCES") {
    reportError(`AFR 无法启动：没有权限监听 ${host}:${port}。`);
  } else {
    reportError(`AFR 无法启动：${detail}`);
  }
  await server?.app.close();
  process.exitCode = 1;
}

function reportError(message: string): void {
  if (server === undefined) {
    process.stderr.write(`${message}\n`);
  } else {
    server.app.log.error(message);
  }
}
