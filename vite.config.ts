import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({ plugins:[tailwindcss()], server:{host:'127.0.0.1'}, build:{target:'es2022'} });
