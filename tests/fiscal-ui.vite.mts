// Harness aislado: no usa Auth, Supabase ni Gateway reales.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  server: { watch: { ignored: ["**/.output/**", "**/.vercel/**"] } },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: "@/lib/supabase",
        replacement: fileURLToPath(new URL("./fiscal-ui-mock.ts", import.meta.url)),
      },
      { find: "@", replacement: fileURLToPath(new URL("../src", import.meta.url)) },
    ],
  },
  define: {
    "import.meta.env.VITE_SUPABASE_URL": JSON.stringify("http://127.0.0.1:5193/simulated"),
  },
});
