import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages는 저장소 이름 아래 경로로 서비스된다
export default defineConfig({
  base: '/microneedle-ipc/',
  plugins: [react(), tailwindcss()],
})
