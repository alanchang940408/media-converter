// Renderer-only dev server (no Electron). window.api is replaced by src/renderer/src/mockApi.ts.
// Used for quick UI work and browser-pane previews: `npm run dev:web` → http://localhost:5199
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  server: { port: 5199, strictPort: true },
})
