export * from "./src/index.ts";

if (import.meta.main) {
  const { runCli } = await import("./src/cli.ts");
  await runCli();
}
