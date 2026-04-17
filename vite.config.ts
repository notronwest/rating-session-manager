import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const appName = env.APP_NAME || "sessionmanager";
  return {
    plugins: [react()],
    root: "web",
    server: {
      port: 3000,
      proxy: {
        "/api": "http://localhost:3001",
      },
    },
    build: {
      outDir: `../../www/${appName}`,
      emptyOutDir: true,
    },
  };
});
