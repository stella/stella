// Setup owns installation. An MCP handshake must not wait for the package
// registry or race another session installing into the same checkout.
try {
  const [{ StdioServerTransport }, { createStellaDocsServer }] =
    await Promise.all([
      import("@modelcontextprotocol/sdk/server/stdio.js"),
      import("./server.ts"),
    ]);
  const transport = new StdioServerTransport();
  await createStellaDocsServer().connect(transport);
} catch (error) {
  process.stderr.write(`[stella-docs] Startup failed: ${String(error)}\n`);
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND")
  ) {
    process.stderr.write(
      "[stella-docs] Dependencies are missing or incomplete. Run `bun run setup:mcp` from the repository root (or `bun run setup:worktree` for a fresh worktree), then reconnect the MCP server.\n",
    );
  }
  process.exit(1);
}
