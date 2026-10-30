import type { NextConfig } from 'next';
const config: NextConfig = { devIndicators: false, ...(process.env.DESKTOP_BUILD === '1' ? { output: 'export' as const } : {}) };
export default config;
