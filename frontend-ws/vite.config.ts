import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        // target: 'http://localhost:3001',
        target: 'http://13.60.28.235:3001',
        changeOrigin: true,
      }
    }
  }
})
