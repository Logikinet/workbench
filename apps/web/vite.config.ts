import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Personal AI Workbench",
        short_name: "AI Workbench",
        description: "本地优先的受控 AI 工作台",
        display: "standalone",
        start_url: "/",
        theme_color: "#101826",
        background_color: "#101826",
        icons: [
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable"
          }
        ]
      }
    })
  ]
});
