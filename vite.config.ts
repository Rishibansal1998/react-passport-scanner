import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    react(),
    dts({ 
      include: ['src'],
      insertTypesEntry: true,
      tsconfigPath: './tsconfig.app.json',
    })
  ],
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'ReactPassportScanner',
      fileName: (format) => `react-passport-scanner.${format}.js`,
    },
    rollupOptions: {
      external: ['react', 'react-dom'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
        },
      },
    },
  },
});