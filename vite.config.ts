import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // 0.0.0.0 so the app is reachable from a phone on the same network, which is
    // how the export path has to be tested. localhost only would hide the bugs
    // that matter: Android encoders, Android memory limits, Android thermals.
    host: "0.0.0.0",
    port: 5175,
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
});
