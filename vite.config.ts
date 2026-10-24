import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyRequest, request) => {
            const origin = request.headers.origin;
            if (!origin) return;
            try {
              const parsed = new URL(origin);
              if (parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
                proxyRequest.setHeader("origin", "http://localhost:5173");
              }
            } catch {
              // Keep invalid and non-loopback Origin headers unchanged for the API to reject.
            }
          });
        },
      },
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
