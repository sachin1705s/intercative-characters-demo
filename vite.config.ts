import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false, // never emit source maps in production
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787'
    }
  }
})
