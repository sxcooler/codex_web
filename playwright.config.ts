import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./tests',testMatch:'**/*.spec.ts',workers:1,use:{baseURL:'http://127.0.0.1:4178',headless:true,channel:'msedge',viewport:{width:1440,height:900}},webServer:{command:'npm.cmd run dev -- --host 127.0.0.1 --port 4178 --strictPort',url:'http://127.0.0.1:4178',reuseExistingServer:false}});
